import { setTimeout as delay } from 'node:timers/promises';
import { RunFailure, failureCodeOf, isContextWindowExceeded } from '../../protocol/failure.ts';
import type {
  Message,
  ModelResponse,
  Provider,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from '../../protocol/index.ts';
import { RETRY_MAX_WAIT_MS, retryDelayMs, retryable } from '../../protocol/retry.ts';
import { LEASE_RENEW_INTERVAL_MS } from '../../protocol/session-lease.ts';
import type { resolveRunLimits } from '../../protocol/settings.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import { emptyRequestTiming } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { TokenCalibration } from '../context/calibration.ts';
import type { PreparedContext } from '../context/context.ts';
import { ContextLimitError, prepareContext } from '../context/context.ts';
import { WINDOW_EXHAUSTED, hopelessForWindow } from '../context/forecast.ts';
import type { RunEmit } from './emit.ts';

/**
 * A run's own limit was reached, with the code that says which one.
 *
 * The class already meant "limited" rather than "failed"; what the code adds is *which* limit, so a run
 * result can say "the output limit" instead of leaving a reader to parse the error text. It is a limit on
 * *work* rather than on spend: output produced, not rounds taken — a run has no round cap to reach, and the
 * rounds nobody asked for are counted by the goal that asked for them (see `packages/core/goal-driver.ts`).
 */
class LimitError extends RunFailure {
  constructor(code: 'output-limit', message: string) {
    super(code, message);
    this.name = 'LimitError';
  }
}
/** How much of a truncated attempt's billed output must be reasoning for it to count as only deliberating. */
const REASONING_DOMINANT_SHARE = 0.9;
const REASONING_RESEND_NOTE: Message = {
  role: 'user',
  content:
    '<runtime-context source="output-limit">\n' +
    'The previous attempt at this turn spent its entire output allowance on reasoning and produced no answer or ' +
    'tool call, so it was discarded. Do not re-derive what you already worked out: reason briefly, then make ' +
    'the next tool call or give the answer directly. Keep any single edit small enough to fit.\n' +
    '</runtime-context>',
};
const truncatedCallNote = (toolArgumentChars: number): Message => ({
  role: 'user',
  content:
    '<runtime-context source="output-limit">\n' +
    'The previous attempt at this turn was cut off while writing a tool call (' +
    String(toolArgumentChars) +
    ' characters of arguments) by the output allowance, so the call was discarded and nothing ran. Make the ' +
    'same progress in smaller calls: edit only the lines that change instead of rewriting a file, split a large ' +
    'new file or edit across several calls, and keep reasoning brief.\n' +
    '</runtime-context>',
});

export interface RunRequestOptions {
  store: Pick<
    SessionStore,
    | 'contextSurface'
    | 'retryCount'
    | 'zeroByteRetryCount'
    | 'reasoningResendCount'
    | 'truncatedCallResendCount'
    | 'recordEvent'
    | 'renewLease'
    | 'checkpointStream'
    | 'appendStreamMessage'
  >;
  serialToolRoutes?: Set<string>;
  routeKey?: string;
  sessionId: string;
  runId: string;
  round: number;
  limits: Pick<
    ReturnType<typeof resolveRunLimits>,
    'requestTimeoutMs' | 'maxModelRetries' | 'zeroByteRetries'
  >;
  signal: AbortSignal;
  context: PreparedContext;
  contextInput: Parameters<typeof prepareContext>[0];
  roundContextTokens: number | undefined;
  measuredProvider: Provider;
  specs: ToolSpec[];
  requestedModel: string | null;
  requestedEffort: ReasoningEffort | undefined;
  cacheKeyOf(system: string, tools: readonly ToolSpec[]): string | undefined;
  recordEnvelope(context: PreparedContext): void;
  beforeRequest(system: string): void;
  onVisibleText(delta: string): void;
  onAnswerText(text: string): void;
  /**
   * Mark a plain answer as one the caller expects to replace with another answer from the same turn.
   *
   * Only the successful no-tool-call path takes the mark: a tool-call turn is not an answer, and a partial or
   * interrupted turn is shown as what it is. A callback can resolve pending command observations after a final
   * provider response and before persistence, so unchanged diagnostic work never leaves a provisional answer.
   */
  provisionalAnswer?: boolean | (() => Promise<boolean>);
  commitStepTiming(response: ModelResponse): void;
  statistics: SessionStatistics;
  usage: Usage;
  calibration: TokenCalibration;
  calibrationRouteKey: string | undefined;
  emit: RunEmit;
}

/**
 * Whether the streamed answer should be checkpointed now.
 *
 * A checkpoint rewrites the whole text so far (it is what a crashed run's partial answer is recovered from), so
 * writing it on a fixed clock made the bytes written grow with the square of the answer: a 200 KB answer
 * streamed over a minute was written thirty times at an average of 100 KB. The rule is now geometric — after two
 * seconds, write once the text has grown by an eighth of what is already saved (and at least 4 KB) — so the total
 * written is a small multiple of the answer, not its square. Two bounds keep the recovery promise: the first
 * fragment is saved at once, and nothing waits longer than 30 seconds or 256 K characters unsaved.
 */
export function shouldCheckpointStream(
  chars: number,
  checkpointedChars: number,
  sinceMs: number,
): boolean {
  const grown = chars - checkpointedChars;
  if (grown <= 0) return false;
  if (checkpointedChars === 0) return true;
  if (grown >= 256_000 || sinceMs >= 30_000) return true;
  return sinceMs >= 2_000 && grown >= Math.max(4_096, checkpointedChars / 8);
}

/** One model round, including bounded recovery and durable streaming. The caller owns run/step state. */
export async function requestRunRound(options: RunRequestOptions): Promise<ModelResponse> {
  const {
    store,
    sessionId,
    runId,
    round,
    limits,
    signal,
    contextInput,
    roundContextTokens,
    measuredProvider,
    specs,
    requestedModel,
    requestedEffort,
    cacheKeyOf,
    recordEnvelope,
    beforeRequest,
    onVisibleText,
    onAnswerText,
    provisionalAnswer = false,
    commitStepTiming,
    statistics,
    usage,
    calibration,
    calibrationRouteKey,
    emit,
  } = options;
  let { context } = options;
  const serialToolRoutes = options.serialToolRoutes ?? new Set<string>();
  const routeKey = options.routeKey ?? '';
  let recoveringArguments = false;
  let degradedFrom: number | undefined;
  const countUsage = (used: Usage): void => {
    usage.inputTokens += used.inputTokens;
    usage.outputTokens += used.outputTokens;
    if (used.cachedInputTokens !== undefined)
      usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + used.cachedInputTokens;
    if (used.cacheWriteInputTokens !== undefined)
      usage.cacheWriteInputTokens = (usage.cacheWriteInputTokens ?? 0) + used.cacheWriteInputTokens;
  };
  let text = '';
  const requestSignal = limits.requestTimeoutMs
    ? AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)])
    : signal;
  const messageId = `${runId}:${round}`;
  emit('message.started', { messageId });
  let streamedText = '';
  /**
   * This round's reasoning, on its own accumulator.
   *
   * It is kept apart from `streamedText` everywhere — it is not the answer, so it never becomes
   * `RunResult.text`, never goes back to a provider, and never enters the stream checkpoint (an
   * interrupted turn preserves what the user can read; half a thought is not that). It is discarded
   * whole when an attempt is thrown away, so what is stored is the reasoning of the attempt whose
   * answer was stored.
   */
  let streamedReasoning = '';
  let checkpointChars = 0;
  let checkpointAt = 0;
  /**
   * Captured before the request so the provider's reported usage can be compared against the uncorrected
   * estimate that admitted this exact request. A recovered round reassigns both, so the calibration
   * always sees the request that was actually answered rather than the one that was refused.
   */
  let rawInputEstimate = 0;
  /** The sizes that estimate was assembled from, so the endpoint's answer can be read per part. */
  let roundBytes: { system: number; tools: number; messages: number } | undefined;
  let requestOutputLimit = 0;
  /**
   * How many recoveries from a provider-confirmed context overflow this round has spent.
   *
   * The allowance comes from the compaction policy the round resolved — one attempt by default, because a
   * conversation that still does not fit after the most aggressive compression available cannot be made to
   * fit by repeating the same decision.
   */
  let overflowAttempts = 0;
  let lastCompactionProblem = context.compactionProblem;
  /**
   * Take back the reasoning the user has already seen.
   *
   * Reasoning is streamed live (see `message.reasoning`), so an attempt that is thrown away has to take
   * its thinking with it: otherwise a re-sent round would leave the folded block showing two attempts'
   * reasoning as one, and the live view would disagree with the message that gets stored. The frame is a
   * reset rather than a correction because a client cannot un-know deltas it has already rendered.
   */
  const resetReasoning = (): void => {
    if (!streamedReasoning) return;
    streamedReasoning = '';
    emit('message.reasoning', { messageId, text: '', reset: true });
  };
  /**
   * Compress the conversation once more, and report whether the round should be sent again.
   *
   * `compacted: false` is the answer that decides it: it means there was no boundary left to compress,
   * so the re-sent request would be byte-for-byte the one that just failed and the original failure
   * stands. Every caller requires an empty `streamedText` first, so the retry can never duplicate output
   * the user has already seen.
   */
  const recoverFromOverflow = async (): Promise<boolean> => {
    if (overflowAttempts >= (context.maxOverflowRetries ?? 1)) {
      // The retry was refused as well. Reporting it is the point: an operator reading this run's stream
      // sees both the compression that was tried and the refusal that outlived it.
      emit('context.overflow', {
        round,
        recovered: false,
        coveredMessages: store.contextSurface(sessionId)?.coveredMessages ?? 0,
      });
      return false;
    }
    overflowAttempts++;
    const before = store.contextSurface(sessionId)?.coveredMessages ?? 0;
    let forced: PreparedContext | undefined;
    try {
      forced = await prepareContext({ ...contextInput, forceCompact: true });
    } catch (cause) {
      // Compression cannot always even be attempted — a conversation with a single message has no
      // boundary to compress at, and says so by refusing. That is not a second failure to report: it is
      // the answer that the request has to stand as it is, so the provider's own failure is what the
      // user sees.
      forced = undefined;
      lastCompactionProblem = cause instanceof Error ? cause.message : String(cause);
    }
    const coveredMessages = store.contextSurface(sessionId)?.coveredMessages ?? before;
    if (!forced?.compacted) {
      lastCompactionProblem = forced?.compactionProblem ?? lastCompactionProblem;
      emit('context.overflow', { round, recovered: false, coveredMessages });
      return false;
    }
    context = forced;
    lastCompactionProblem = undefined;
    // The re-send carries a different envelope — the forced compression changed the summary the request
    // opens with — so this round writes a second record rather than leaving the log claiming it sent the
    // prompt that was refused.
    recordEnvelope(forced);
    emit('context.overflow', { round, recovered: true, coveredMessages });
    // The attempt that was refused is discarded whole. Its reasoning was already streamed, so the
    // reset goes out too: otherwise the folded block would show two attempts' thinking as one, and
    // the live view would disagree with the message that gets stored.
    resetReasoning();
    // Durable, because it is a decision about the conversation that no checkpoint explains: the
    // compression is recorded, "the provider refused this for size and we answered by compressing" is not.
    store.recordEvent(sessionId, 'context.overflow', {
      round,
      recovered: true,
      coveredMessages,
    });
    return true;
  };
  /**
   * Send this round, answering a context overflow once and a transient failure as often as the retry
   * allowance for this round permits.
   *
   * This is the step boundary the retries belong to, and moving them here from the transport is what makes
   * them worth having. The transport could only ever see an HTTP status before the stream started, could
   * not retry a stream that broke mid-flight, left nothing in the record, and forgot its count when the
   * process did. Here the same decision covers a broken stream, the count is a row in the log that the
   * next process reads back, and the wait is cancelled by the same Stop that cancels everything else.
   *
   * Two rules keep a retry from costing more than it buys:
   *
   * - **Nothing has been shown yet.** A retry re-sends the request, so any text the user already saw
   *   would be shown twice. Displayed reasoning can be reset before a resend.
   * - **The failure is transient by nature** (`retryable`), never a failure that describes the run's own
   *   room or the request's content: re-sending those buys the same answer at full price.
   */
  /**
   * Whether this failure is one an empty attempt produced, and so may be sent again on its own allowance.
   *
   * The definition is deliberately narrow, and it is the point of the feature: no response headers were received,
   * or the response carried zero body bytes, *and* no stream event was parsed, *and* the code says the connection
   * failed rather than the endpoint refusing the request. Anything that streamed even one reasoning chunk is not
   * this: re-sending it would pay twice for the same thought.
   */
  const zeroByteFailure = (cause: unknown): boolean => {
    const code = failureCodeOf(cause);
    if (code !== 'timeout' && code !== 'transport') return false;
    const details = cause instanceof RunFailure ? cause.details : undefined;
    return details?.responseBytes === 0 && details?.events === 0;
  };
  /**
   * The separate allowance for an empty attempt.
   *
   * Counted from its own record rather than from `llm.retry`: an operator with a normal retry budget must not
   * have it spent on a re-send that duplicated nothing, and an evaluation that sets `maxModelRetries=0` still
   * gets its one zero-byte re-send. A zero-byte failure is *not* guaranteed to be free — the endpoint may have
   * received the request and billed for it — which is why this records `re-sent`, not `free`.
   */
  const zeroByteRetry = async (cause: unknown): Promise<boolean> => {
    if (!zeroByteFailure(cause)) return false;
    const attempts = store.zeroByteRetryCount(runId, round, sessionId);
    if (attempts >= limits.zeroByteRetries) return false;
    const record = {
      runId,
      round,
      attempt: attempts + 1,
      firstRequestMs: cause instanceof RunFailure ? (cause.details?.durationMs ?? 0) : 0,
    };
    // Recorded before the re-send, for the same reason the retry record is: the count and the fact are one write.
    store.recordEvent(sessionId, 'llm.zero-byte-retry', record);
    emit('llm.zero-byte-retry', record);
    return true;
  };
  /**
   * Whether this truncated attempt is one that only deliberated, and may be sent once more asking for the action.
   *
   * A reasoning model can spend the whole output allowance thinking and stop before a word or a complete call:
   * the 2026-10-29 sample lost a task to 16384 of 16384 tokens of reasoning and nothing else. That is not the
   * task being too big for the allowance, which is what `output-limit` otherwise means — the same request with a
   * note to act on the reasoning already done usually lands. Narrow on purpose: nothing visible was streamed (a
   * re-send would show it twice), reasoning is most of what was billed, and one re-send per round, counted from
   * its own record like the zero-byte allowance.
   */
  let resendNote: Message | undefined;
  const reasoningResend = (attempt: ModelResponse): boolean => {
    const reasoning = attempt.outputDiagnostics?.reasoningTokens;
    if (
      attempt.finishReason !== 'length' ||
      attempt.truncation === 'context-window' ||
      streamedText ||
      reasoning === undefined ||
      reasoning < attempt.usage.outputTokens * REASONING_DOMINANT_SHARE
    )
      return false;
    if (store.reasoningResendCount(runId, round, sessionId) >= 1) return false;
    const record = {
      runId,
      round,
      outputTokens: attempt.usage.outputTokens,
      reasoningTokens: reasoning,
    };
    // Recorded before the re-send: the record is the allowance (see `zeroByteRetry`).
    store.recordEvent(sessionId, 'llm.reasoning-resend', record);
    emit('llm.reasoning-resend', record);
    // The discarded attempt was billed all the same.
    countUsage(attempt.usage);
    resetReasoning();
    resendNote = REASONING_RESEND_NOTE;
    return true;
  };
  /**
   * Whether this truncated attempt was cut off inside a tool call, and may be sent once more asking for smaller calls.
   *
   * The other way the 2026-10-29 sample lost a task to the allowance: the reasoning fit, the arguments of one large
   * call did not, and half a JSON document is not a call. The task usually fits as several smaller calls, so the
   * request goes again once with a note saying so. Same narrowing as the reasoning re-send — nothing visible was
   * streamed, one re-send per round on its own record — and the same note-only-on-this-request shape.
   */
  const truncatedCallResend = (attempt: ModelResponse): boolean => {
    const chars = attempt.outputDiagnostics?.toolArgumentChars ?? 0;
    if (
      attempt.finishReason !== 'length' ||
      attempt.truncation === 'context-window' ||
      streamedText ||
      chars <= 0
    )
      return false;
    if (store.truncatedCallResendCount(runId, round, sessionId) >= 1) return false;
    const record = {
      runId,
      round,
      outputTokens: attempt.usage.outputTokens,
      toolArgumentChars: chars,
    };
    store.recordEvent(sessionId, 'llm.truncated-call-resend', record);
    emit('llm.truncated-call-resend', record);
    countUsage(attempt.usage);
    resetReasoning();
    resendNote = truncatedCallNote(chars);
    return true;
  };
  const retryRequest = async (cause: unknown): Promise<boolean> => {
    const code = failureCodeOf(cause);
    if (!retryable(code)) return false;
    const attempts = store.retryCount(runId, round, sessionId);
    if (attempts >= limits.maxModelRetries) return false;
    const waitMs = retryDelayMs(
      attempts + 1,
      cause instanceof RunFailure ? cause.retryAfterMs : undefined,
    );
    // The endpoint's own cooldown is never shortened; one longer than we are willing to hold a round
    // open is not retried at all, because the alternative is ignoring what it asked for.
    if (waitMs > RETRY_MAX_WAIT_MS) return false;
    const retry = {
      runId,
      round,
      attempt: attempts + 1,
      max: limits.maxModelRetries,
      code,
      waitMs,
    };
    /**
     * Recorded before the wait, so the record and the count are the same fact: an attempt that is already
     * written down is one the next process will not make again, whether this one survives the wait or not.
     */
    store.recordEvent(sessionId, 'llm.retry', retry);
    emit('llm.retry', retry);
    const waitStarted = performance.now();
    try {
      await delay(waitMs, undefined, { signal: requestSignal });
    } catch (error) {
      /**
       * A cancelled wait reports *why* it was cancelled, not that a timer was cancelled.
       * `timers/promises` rejects with its own `AbortError`, which would make a request-deadline abort
       * during the backoff look like an anonymous failure; the signal's own reason is either the
       * timeout that fired or the Stop that arrived, and both are things the run can name.
       */
      requestSignal.throwIfAborted();
      throw error;
    } finally {
      (statistics.requestTiming ??= emptyRequestTiming()).retryWaitMs += Math.max(
        0,
        performance.now() - waitStarted,
      );
    }
    return true;
  };
  const sendRequest = async (): Promise<ModelResponse> => {
    for (;;) {
      /**
       * The numbers this attempt was decided on, reported so a client and an operator see the same
       * prediction the run acted on — not a recomputation that may disagree with it. A round that
       * recovered reports the prediction it was re-sent with.
       */
      emit('context.forecast', {
        round,
        inputTokens: context.forecast.inputTokens,
        rawInputTokens: context.forecast.rawInputTokens,
        outputTokens: context.forecast.outputTokens,
        windowRoom: context.forecast.windowRoom,
        // What the estimate is made of. "The request is too big" is not actionable on its own: a catalog
        // of tool schemas can cost more than the conversation, and this is the number that says so.
        breakdown: context.forecast.breakdown,
        shortened: context.shortened,
        freedChars: context.freedChars,
        // Reported beside the shortening pair rather than folded into it: the two are different bargains —
        // a pointer to the full text, or the middle gone with nothing to read back — and an operator
        // reading a round that made the conversation smaller needs to know which one it got.
        pruned: context.pruned,
        prunedChars: context.prunedChars,
        compacted: context.compacted,
        // Why proactive compression is off for this route, when it is: a window that cannot carry the
        // request's output reservation plus the headroom is a configuration mistake, and a reader of the
        // stream should see that rather than wonder why a small window never compressed.
        ...(context.policyProblem === undefined ? {} : { policyProblem: context.policyProblem }),
        // Why the request cannot be sent, when it cannot: without it the stream shows numbers the reader
        // has to compare by hand to learn the same one word.
        ...(context.forecast.problem === undefined ? {} : { problem: context.forecast.problem }),
      });
      /**
       * A request the estimate says does not fit is still sent — unless the estimate is far past the window.
       *
       * The run is the caller that knows what "does not fit" means, and the answer used to be "fail here",
       * which made a heuristic the authority on somebody else's endpoint: an uncalibrated estimate can be
       * wrong by the width of its own clamp. `hopelessForWindow` is where that stops being plausible, and
       * everything under it is sent: the endpoint answers, or refuses for size and the round compresses and
       * re-sends. The round is told why it is uncompressed through `compactionProblem` in the frame above.
       */
      if (context.forecast.problem && hopelessForWindow(context.forecast, roundContextTokens))
        throw new ContextLimitError(
          context.compactionProblem
            ? 'Context compaction failed: ' + context.compactionProblem + '; ' + WINDOW_EXHAUSTED
            : WINDOW_EXHAUSTED,
        );
      rawInputEstimate = context.forecast.rawInputTokens;
      roundBytes = context.forecast.bytes;
      requestOutputLimit = context.forecast.outputTokens;
      let attempt: ModelResponse;
      /**
       * While the request is in flight the run is working, and the lease says so.
       *
       * The renewal is on a timer rather than only at the boundaries around this request because a model
       * call can take minutes: without it a healthy run would look idle for the whole of it. It decides
       * nothing — the timer cannot expire anything, and `LEASE_RENEW_INTERVAL_MS` is not a timeout.
       */
      const renewing = setInterval(() => {
        // A throw from a timer callback is not catchable by the request's own `try`: an unguarded
        // `SQLITE_BUSY` here would be an uncaught exception that ends the Host mid-run. The renewal is
        // advisory by design (see above), so a failed one is dropped instead of escalated.
        try {
          store.renewLease(sessionId, runId);
        } catch {
          /* The lease is re-read at the next boundary; a busy database must not end the run. */
        }
      }, LEASE_RENEW_INTERVAL_MS);
      renewing.unref?.();
      try {
        beforeRequest(context.system);
        attempt = await measuredProvider.complete({
          system: context.system,
          ...(recoveringArguments || serialToolRoutes.has(routeKey)
            ? { parallelToolCalls: false as const }
            : {}),
          ...(recoveringArguments ? { toolArgumentsRecovery: true, degradedFrom } : {}),
          // The note rides on this request only: it is about the attempt that was discarded, not the conversation.
          messages: resendNote ? [...context.messages, resendNote] : context.messages,
          tools: specs,
          // The key of the request this is, from the prompt this request carries — see `cacheKeyOf`.
          cacheKey: cacheKeyOf(context.system, specs),
          ...(requestedModel === null ? {} : { model: requestedModel }),
          ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
          signal: requestSignal,
          maxOutputTokens: requestOutputLimit,
          onText: (delta) => {
            // Only text about to become a message.delta is a visible first token. Internal
            // summaries share the measured provider but never enter this callback.
            onVisibleText(delta);
            streamedText += delta;
            if (
              delta &&
              shouldCheckpointStream(
                streamedText.length,
                checkpointChars,
                performance.now() - checkpointAt,
              )
            ) {
              store.checkpointStream(sessionId, runId, messageId, streamedText);
              checkpointChars = streamedText.length;
              checkpointAt = performance.now();
            }
            emit('message.delta', { messageId, text: delta });
          },
          onReasoning: (delta) => {
            streamedReasoning += delta;
            emit('message.reasoning', { messageId, text: delta });
          },
        });
      } catch (cause) {
        if (cause instanceof RunFailure && cause.details?.usage) countUsage(cause.details.usage);
        if (recoveringArguments) {
          // The one changed-body recovery has its own failure boundary; never retry it again.
          cause = new RunFailure(
            'tool-arguments-dropped',
            failureCodeOf(cause) === 'tool-arguments-dropped'
              ? 'Tool arguments missing after one re-send with parallel tool calls disabled; still missing required arguments'
              : cause instanceof RunFailure &&
                  cause.code === 'http' &&
                  cause.httpStatus !== undefined &&
                  cause.httpStatus >= 400 &&
                  cause.httpStatus < 500 &&
                  /parallel[_ -]tool[_ -]calls/i.test(cause.message)
                ? 'Model endpoint does not accept disabling parallel tool calls'
                : 'Tool argument recovery failed: ' +
                  (cause instanceof Error ? cause.message : 'Model request failed'),
            { cause },
          );
        } else if (failureCodeOf(cause) === 'tool-arguments-dropped') {
          if (!streamedText) {
            recoveringArguments = true;
            degradedFrom = cause instanceof RunFailure ? cause.details?.requestNumber : undefined;
            resetReasoning();
            continue;
          }
          cause = new RunFailure(
            'tool-arguments-dropped',
            'Tool arguments missing after a partial answer; request was not re-sent',
            { cause },
          );
        }
        // A refused request is recoverable only while nothing has been shown: once text has streamed,
        // compressing and re-sending would show the beginning of the turn to the user twice.
        if (!streamedText && isContextWindowExceeded(cause)) {
          if (await recoverFromOverflow()) continue;
          if (lastCompactionProblem)
            throw new RunFailure(
              'context-window-exceeded',
              'Provider context window exceeded; context compaction failed: ' +
                lastCompactionProblem,
              {
                cause,
                ...(cause instanceof RunFailure
                  ? {
                      httpStatus: cause.httpStatus,
                      requestId: cause.requestId,
                      retryAfterMs: cause.retryAfterMs,
                    }
                  : {}),
              },
            );
        }
        // An attempt that produced nothing at all is re-sent on its own allowance first; only once that is
        // exhausted does the ordinary retry policy get a say. Nothing was shown, so nothing can be duplicated.
        if (!streamedText && (await zeroByteRetry(cause))) continue;
        // A transient failure is re-sent under the same rule, and for the same reason.
        if (!streamedText && (await retryRequest(cause))) {
          /**
           * Only `streamedText` blocks a retry. Reasoning that was displayed belongs to the attempt being
           * discarded, and the frame that takes it back already exists — the overflow recovery sends it —
           * so a round whose endpoint failed after thinking aloud is retried rather than abandoned. The
           * guard used to be `!streamedReasoning` as well, which turned "the endpoint streamed a thought
           * and then broke" into a failed run that had produced no answer at all.
           */
          resetReasoning();
          continue;
        }
        // An interrupted stream may have shown useful text before the provider failed. Preserve
        // exactly those visible deltas, but never persist or execute incomplete tool calls.
        if (streamedText) {
          onAnswerText((text = streamedText));
          const message: Message = {
            role: 'assistant',
            content: streamedText,
            toolCalls: [],
            interrupted: true,
            ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
          };
          store.appendStreamMessage(sessionId, runId, messageId, message);
          emit('message.finished', { messageId, message });
        }
        throw cause;
      } finally {
        clearInterval(renewing);
      }
      // A terminal overflow is recoverable only before visible text; later it is persisted and classified below.
      if (
        attempt.finishReason === 'length' &&
        attempt.truncation === 'context-window' &&
        !streamedText
      ) {
        if (!recoveringArguments && (await recoverFromOverflow())) continue;
        /**
         * Recovery is over, and the provider's own reason is the one that stands.
         *
         * It can be over in two ways, and they are different sentences: compaction ran and could not free
         * enough room (`lastCompactionProblem`), or the recovery allowance was already spent. The second is the
         * ordinary one — the attempt that *succeeded* clears the problem, so the next overflow in the same round
         * arrives here with nothing to name. Falling through instead ended the round at the `length` branch
         * below, which reports an **output** limit: the one diagnosis that says "compress nothing", about a
         * request the provider refused for size.
         */
        throw new ContextLimitError(
          lastCompactionProblem
            ? 'Provider context window exceeded; context compaction failed: ' +
                lastCompactionProblem
            : 'Provider context window exceeded; the overflow recovery allowance is spent',
        );
      }
      if (!recoveringArguments && (reasoningResend(attempt) || truncatedCallResend(attempt)))
        continue;
      /**
       * A turn that carried nothing at all goes through the same retry decision as a broken stream.
       *
       * Where this is judged is the whole point. It used to be judged after `sendRequest` had returned,
       * which put it outside the retry path entirely: `empty-response` was in the retry table but no
       * failure could reach it, so an endpoint that closed a turn with an empty body ended the run where a
       * transport hiccup on the same request would have been re-sent for free.
       *
       * "Nothing at all" is the test, and it is deliberately wider than the envelope. Text, tool calls,
       * streamed text and streamed reasoning all count as something: a thinking model that answered only
       * in its reasoning channel has still answered, and re-sending it would spend the request again to
       * throw away the thought the user is reading. What is left is a turn that produced no text, no call
       * and no thought, which is a hiccup rather than an answer whatever the finish reason says — and
       * because `carried` is false, nothing has been shown to the user, so a re-send cannot duplicate
       * output. A turn the endpoint stopped on purpose is not judged here at all — `length` and
       * `content-filter` are owned by the branches around this one, and re-sending a filtered request would
       * spend a round to be refused again.
       */
      const carried =
        attempt.toolCalls.length > 0 ||
        attempt.text.trim() !== '' ||
        streamedText !== '' ||
        streamedReasoning !== '';
      // A zero reservation is the forecast's "no room to reserve output" sentinel, not a cap the endpoint was
      // asked to honour: that request is sent precisely so the endpoint can be the authority on whether it fits.
      // Treating any output under it as over-cap would turn every such answer into `limited`.
      const attemptOverCap =
        requestOutputLimit > 0 && attempt.usage.outputTokens > requestOutputLimit;
      if (
        !carried &&
        !attemptOverCap &&
        attempt.finishReason !== 'length' &&
        attempt.finishReason !== 'content-filter'
      ) {
        const empty = new RunFailure(
          'empty-response',
          attempt.finishReason === 'tool_calls'
            ? 'Provider returned an empty tool-call turn'
            : 'Provider returned a turn with no content',
        );
        if (!recoveringArguments && (await retryRequest(empty))) continue;
        throw empty;
      }
      if (
        recoveringArguments &&
        attempt.finishReason !== 'length' &&
        attempt.finishReason !== 'content-filter'
      ) {
        serialToolRoutes.add(routeKey);
        const degraded = {
          runId,
          round,
          route: routeKey,
          reason: 'tool-arguments-dropped',
          parallelToolCalls: false,
        };
        store.recordEvent(sessionId, 'provider.degraded', degraded);
        emit('provider.degraded', degraded);
      }
      return attempt;
    }
  };
  const response = await sendRequest();
  /**
   * What the endpoint billed, read as evidence about each part.
   *
   * One total, but the round knows how that total was assembled — the system prompt, the catalogue and the
   * conversation, in bytes — so the residual is attributed to the parts by their share of it. That is what
   * lets a route whose catalogue is overestimated and whose conversation is underestimated end up with two
   * weights pointing in opposite directions instead of one average that is wrong for both.
   */
  calibration.observe(
    rawInputEstimate,
    response.usage.inputTokens,
    rawInputEstimate > 0 ? roundBytes : undefined,
  );
  /**
   * The measurement is durable, because it is about the endpoint rather than about this run.
   *
   * Written per observed round rather than once at the end: a run that is stopped, crashes or is cancelled
   * keeps what it had already learned, which is the whole reason the reading half exists. Rounds that reported
   * no usable usage are already filtered out by `observe` — the state simply does not move for them — so this
   * records the value that was in force for the round, which is what a reader asking "what correction was
   * this round sized against" needs. The anchor travels with it: the estimate this round was sized from and
   * the usage that came back are the two numbers that make the correction checkable rather than merely
   * present.
   */
  if (calibrationRouteKey !== undefined)
    store.recordEvent(sessionId, 'context.calibration', {
      route: calibrationRouteKey,
      factor: calibration.factor,
      samples: calibration.observed,
      parts: calibration.parts,
      anchor: {
        rawEstimate: rawInputEstimate,
        reportedInputTokens: response.usage.inputTokens,
      },
    });
  countUsage(response.usage);
  /**
   * The part of a stopped turn that is still true: what the user already saw.
   *
   * Both ways a turn can be stopped after producing text — the output limit and the endpoint's own policy — have
   * to persist that text before failing, or the answer appears and then vanishes when the UI rebuilds from
   * history. Tool calls are dropped by both: a truncated call is half a JSON document, and a call from a turn
   * the endpoint refused to finish was never allowed to run.
   */
  const recordPartialTurn = (answer: ModelResponse): void => {
    onAnswerText((text = answer.text));
    if (!text.trim()) return;
    store.appendStreamMessage(sessionId, runId, messageId, {
      role: 'assistant',
      content: text,
      toolCalls: [],
      interrupted: true,
      ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
    });
    emit('message.finished', {
      messageId,
      message: {
        role: 'assistant',
        content: text,
        toolCalls: [],
        interrupted: true,
        ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
      },
      usage: answer.usage,
    });
  };
  if (response.finishReason === 'content-filter') {
    recordPartialTurn(response);
    // It spent what it spent, for the same reason a truncated answer did.
    commitStepTiming(response);
    throw new RunFailure(
      'content-filtered',
      'The provider stopped this turn for a content policy reason (content filter); the same request will be ' +
        'stopped again, so nothing was re-sent',
    );
  }
  // A compatible endpoint may ignore the requested cap and still report a normal stop. Its reported usage
  // remains billable evidence, but the oversized response must not start tools or masquerade as completion.
  // `requestOutputLimit === 0` is the forecast's "no reservation" sentinel: no positive cap was requested, so the
  // endpoint's answer is the one the run asked for (the over-window estimate already carries `problem`).
  const outputCapExceeded =
    requestOutputLimit > 0 && response.usage.outputTokens > requestOutputLimit;
  if (response.finishReason === 'length' || outputCapExceeded) {
    recordPartialTurn({ ...response, text: response.text || streamedText });
    // A truncated answer is still an answer: it assembled a message, so the step spent what it spent.
    commitStepTiming(response);
    if (response.truncation === 'context-window')
      throw new ContextLimitError(
        'Provider context window exceeded after partial output; the request was not re-sent',
      );
    const details = response.outputDiagnostics;
    const breakdown = [
      String(response.usage.outputTokens) + '/' + String(requestOutputLimit) + ' output tokens',
      ...(details?.reasoningTokens === undefined
        ? []
        : [String(details.reasoningTokens) + ' reasoning tokens']),
      ...(details?.reasoningChars
        ? [String(details.reasoningChars) + ' reasoning characters']
        : []),
      String(details?.visibleChars ?? text.length) + ' visible characters',
      ...(details?.toolArgumentChars
        ? [String(details.toolArgumentChars) + ' tool argument characters']
        : []),
    ];
    throw new LimitError(
      'output-limit',
      'Model output limit reached (' +
        breakdown.join(', ') +
        (outputCapExceeded ? '; endpoint reported output above the requested cap' : '') +
        '); partial tool calls were not executed',
    );
  }
  const ids = new Set<string>();
  for (const call of response.toolCalls) {
    if (!call.id || ids.has(call.id)) throw new Error('Invalid or duplicate tool call ID');
    ids.add(call.id);
  }
  // A turn that carried nothing was already refused inside `sendRequest`, where the retry decision could
  // see it; what is left here is the envelope contradicting itself, which no re-send can repair.
  if (response.finishReason === 'stop' && response.toolCalls.length > 0)
    throw new Error('Provider stop reason conflicts with tool calls');
  onAnswerText((text = response.text));
  let provisional = false;
  if (response.toolCalls.length === 0) {
    try {
      provisional =
        typeof provisionalAnswer === 'function' ? await provisionalAnswer() : provisionalAnswer;
    } catch (error) {
      // A completed provider response survives cancellation during the final workspace observation.
      if (!signal.aborted) throw error;
    }
  }
  store.appendStreamMessage(sessionId, runId, messageId, {
    role: 'assistant',
    content: text,
    toolCalls: response.toolCalls,
    ...(response.providerState ? { providerState: response.providerState } : {}),
    ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
    ...(provisional ? { provisional: true } : {}),
  });
  emit('message.finished', {
    messageId,
    // `providerState` stays out of the event — it is the protocol's business, not the client's — while
    // the reasoning is in it, because the folded block is exactly what the client has to render.
    message: {
      role: 'assistant',
      content: text,
      toolCalls: response.toolCalls,
      ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
      ...(provisional ? { provisional: true } : {}),
    },
    usage: response.usage,
  });
  // The step's spans close here, with the answer that ends it: the rounds that returned before this
  // point — a refused request the round recovered from — assembled nothing and are already accounted
  // for by the step's own start, so no attempt can be charged twice.
  commitStepTiming(response);

  return response;
}
