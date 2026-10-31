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
 * A run's own limit was reached, with a code naming which one. A limit on work (output produced),
 * not on rounds: runs have no round cap (see `packages/core/goal-driver.ts`).
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
   * Mark a plain answer as one the caller expects to replace in the same turn. Only the successful
   * no-tool-call path takes it. A callback form can resolve pending command observations before
   * persistence.
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
 * Whether the streamed answer should be checkpointed now. Geometric rather than clock-based, so
 * total bytes written stay a small multiple of the answer: after two seconds, write once the text
 * grew by an eighth of what is saved (at least 4 KB). The first fragment saves at once; nothing
 * waits over 30 s or 256 K chars.
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
   * This round's reasoning, kept apart from `streamedText`: never the answer, never sent back to a
   * provider, never checkpointed. Discarded with its attempt.
   */
  let streamedReasoning = '';
  let checkpointChars = 0;
  let checkpointAt = 0;
  /**
   * The uncorrected estimate that admitted this request, compared against reported usage.
   * Reassigned on recovery so calibration sees the request actually answered.
   */
  let rawInputEstimate = 0;
  /** The sizes that estimate was assembled from, so the endpoint's answer can be read per part. */
  let roundBytes: { system: number; tools: number; messages: number } | undefined;
  let requestOutputLimit = 0;
  /**
   * Recoveries from a provider-confirmed overflow spent this round. The allowance comes from the
   * compaction policy (one by default).
   */
  let overflowAttempts = 0;
  let lastCompactionProblem = context.compactionProblem;
  /**
   * Retract reasoning already streamed for a discarded attempt, with a reset frame, since clients
   * cannot un-render deltas.
   */
  const resetReasoning = (): void => {
    if (!streamedReasoning) return;
    streamedReasoning = '';
    emit('message.reasoning', { messageId, text: '', reset: true });
  };
  /**
   * Compress once more and report whether to re-send. `compacted: false` means nothing was left to
   * compress, so the original failure stands. Callers require empty `streamedText` first.
   */
  const recoverFromOverflow = async (): Promise<boolean> => {
    if (overflowAttempts >= (context.maxOverflowRetries ?? 1)) {
      // The retry was refused too; report both the compression and the refusal.
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
      // Compression could not be attempted (no boundary), so the provider's failure stands.
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
    // The re-send has a different envelope, so record it.
    recordEnvelope(forced);
    emit('context.overflow', { round, recovered: true, coveredMessages });
    // Discard the refused attempt, including its streamed reasoning.
    resetReasoning();
    // Durable: the provider refused for size and the round answered by compressing.
    store.recordEvent(sessionId, 'context.overflow', {
      round,
      recovered: true,
      coveredMessages,
    });
    return true;
  };
  // Send this round, answering an overflow once and transient failures within the round's retry
  // allowance. Retries live here, not in the transport, so broken streams are covered, the count is
  // logged and survives restarts, and Stop cancels the wait. Only when nothing visible was shown,
  // and only for retryable failures.
  /**
   * Whether an empty attempt produced this failure: no headers or zero body bytes, no parsed stream
   * event, and a connection failure rather than a refusal. Such attempts get their own re-send
   * allowance.
   */
  const zeroByteFailure = (cause: unknown): boolean => {
    const code = failureCodeOf(cause);
    if (code !== 'timeout' && code !== 'transport') return false;
    const details = cause instanceof RunFailure ? cause.details : undefined;
    return details?.responseBytes === 0 && details?.events === 0;
  };
  /**
   * The separate allowance for an empty attempt, counted from its own record so normal retries are
   * not spent (and `maxModelRetries=0` still gets one). The endpoint may still have billed it,
   * hence `re-sent`.
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
   * Whether a truncated attempt only deliberated (reasoning consumed the output allowance, nothing
   * visible), and may be re-sent once with a note to act. One per round, counted from its own
   * record.
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
   * Whether a truncated attempt was cut off inside a tool call, and may be re-sent once asking for
   * smaller calls. Same narrowing as the reasoning re-send.
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
    // Never shorten the endpoint's cooldown; too long a cooldown is not retried.
    if (waitMs > RETRY_MAX_WAIT_MS) return false;
    const retry = {
      runId,
      round,
      attempt: attempts + 1,
      max: limits.maxModelRetries,
      code,
      waitMs,
    };
    /** Recorded before the wait, so the next process will not repeat this attempt. */
    store.recordEvent(sessionId, 'llm.retry', retry);
    emit('llm.retry', retry);
    const waitStarted = performance.now();
    try {
      await delay(waitMs, undefined, { signal: requestSignal });
    } catch (error) {
      /** Report why the wait was cancelled (deadline or Stop), not the timer's own `AbortError`. */
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
      /** Report the prediction this attempt was decided on, not a recomputation. */
      emit('context.forecast', {
        round,
        inputTokens: context.forecast.inputTokens,
        rawInputTokens: context.forecast.rawInputTokens,
        outputTokens: context.forecast.outputTokens,
        windowRoom: context.forecast.windowRoom,
        // What the estimate is made of; tool schemas can outweigh the conversation.
        breakdown: context.forecast.breakdown,
        shortened: context.shortened,
        freedChars: context.freedChars,
        // Reported separately from shortening: pruning leaves nothing to read back.
        pruned: context.pruned,
        prunedChars: context.prunedChars,
        compacted: context.compacted,
        // Why proactive compression is off for this route (window too small for the output
        // reservation plus headroom).
        ...(context.policyProblem === undefined ? {} : { policyProblem: context.policyProblem }),
        // Why the request cannot be sent, when it cannot.
        ...(context.forecast.problem === undefined ? {} : { problem: context.forecast.problem }),
      });
      /**
       * A request the estimate says does not fit is still sent unless far past the window
       * (`hopelessForWindow`); the endpoint decides, and a size refusal triggers compression and a
       * re-send.
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
       * Renew the lease on a timer during the request, since a model call can take minutes. Decides
       * nothing.
       */
      const renewing = setInterval(() => {
        // Timer callbacks are outside the request's `try`; a failed renewal (e.g. `SQLITE_BUSY`) is
        // dropped.
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
            // Only text about to become a `message.delta` counts as a visible first token.
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
        // A size refusal is recoverable only while nothing has been shown.
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
        // An empty attempt uses its own allowance first, then the ordinary retry policy.
        if (!streamedText && (await zeroByteRetry(cause))) continue;
        // A transient failure is re-sent under the same rule, and for the same reason.
        if (!streamedText && (await retryRequest(cause))) {
          /** Only `streamedText` blocks a retry; displayed reasoning is reset. */
          resetReasoning();
          continue;
        }
        // Keep visible text from an interrupted stream, but never persist or run incomplete tool
        // calls.
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
         * Recovery is over (compaction could not free enough, or the allowance is spent), so report
         * the provider's overflow, not an output limit.
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
       * A turn that carried nothing (no text, calls, streamed text or reasoning) goes through the
       * same retry decision as a broken stream. Nothing was shown, so a re-send cannot duplicate
       * output. `length` and `content-filter` are handled by the surrounding branches.
       */
      const carried =
        attempt.toolCalls.length > 0 ||
        attempt.text.trim() !== '' ||
        streamedText !== '' ||
        streamedReasoning !== '';
      // A zero reservation is the forecast's "no room" sentinel, not a cap, so output is not
      // over-cap.
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
   * Attribute the billed total to system prompt, catalogue and conversation by their byte share, so
   * each part gets its own weight.
   */
  calibration.observe(
    rawInputEstimate,
    response.usage.inputTokens,
    rawInputEstimate > 0 ? roundBytes : undefined,
  );
  /**
   * Persist the measurement per observed round, so a stopped run keeps what it learned. The
   * estimate and reported usage travel with it so the correction is checkable.
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
   * Persist the text the user already saw before failing on an output limit or content filter. Tool
   * calls are dropped.
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
  // An endpoint may ignore the requested cap and report a normal stop: bill it, but run no tools
  // and do not treat it as completion. `requestOutputLimit === 0` means no cap was requested.
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
  // Empty turns were handled in `sendRequest`; a `stop` with tool calls is a self-contradiction no
  // re-send can fix.
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
    // `providerState` stays out of the event; the reasoning is in it for the client to render.
    message: {
      role: 'assistant',
      content: text,
      toolCalls: response.toolCalls,
      ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
      ...(provisional ? { provisional: true } : {}),
    },
    usage: response.usage,
  });
  // Close the step's spans with the answer that ends it; recovered attempts assembled nothing.
  commitStepTiming(response);

  return response;
}
