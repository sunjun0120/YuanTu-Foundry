import type { Message, ModelResponse, Provider, ToolSpec, Usage } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { contextMessageSize } from '../../protocol/images.ts';
import { contextBoundaries } from '../../protocol/context.ts';

import { ContextLimitError, estimateInputTokens } from './budget.ts';
import { WINDOW_EXHAUSTED, forecastRequest, windowPressure } from './forecast.ts';
import { resolveCompactionSpec, retentionStart } from './compaction-policy.ts';
import type { RequestForecast } from './forecast.ts';
import { shortenMessages } from './shrink.ts';
import { pruneMessages } from './prune.ts';
import { assertPrunePolicy } from './prune.ts';
import type { PruneOutcome } from './prune.ts';
import type { TokenCalibration } from './calibration.ts';
import { storedSummary, summaryTranscript, withSummary } from './summary.ts';
import { firstHolding, lastHolding } from './boundary-search.ts';
import { projectToolResults } from './tool-results.ts';
export { SUMMARY_INSTRUCTION_PREFIX, SUMMARY_SECTIONS, withoutSummarySection } from './summary.ts';
import type { PreparedContext, PruneSeam, ShrinkSeam } from './seams.ts';
export type { PreparedContext, PruneSeam, ShrinkSeam } from './seams.ts';
export { ContextLimitError } from './budget.ts';
export async function prepareContext(input: {
  store: SessionStore;
  sessionId: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  limit: number;
  signal: AbortSignal;
  maxOutputTokens: number;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  /** How long this summary request may take. A summary is a bounded task, so it always has a limit. */
  summaryTimeoutMs: number;
  onSummaryRetry?: (details: Record<string, unknown>) => void;
  /**
   * Names a summary request for caching, when the caller caches prompts. A function because the
   * summary request is composed here from the caller's system prompt and catalogue, which can
   * change mid-run (e.g. plan approval). Returning `undefined` refuses a key, e.g. when a replayed
   * request no longer matches its record.
   */
  cacheKeyFor?: (system: string, tools: readonly ToolSpec[]) => string | undefined;
  calibration?: TokenCalibration;
  /** Absent when the host has nowhere to put the full text, in which case nothing is shortened. */
  shrink?: ShrinkSeam;
  /** Share of the window at which old tool results are shortened. Absent means only when the request cannot fit. */
  shrinkPercent?: number;
  /**
   * Absent means oversized old results are left whole. Needs nothing from the host, unlike
   * `shrink`.
   */
  prune?: PruneSeam;
  /**
   * Share of the window at which oversized old results lose their middle. Absent means prune only
   * when the request cannot fit.
   */
  prunePercent?: number;
  /**
   * The run this call compacts for. Compaction goes through the session's write lease:
   * `claimCompaction` before the first summary request, re-checked by `applyCompaction`. Absent for
   * store-level callers with no lease.
   */
  runId?: string;
  onUsage: (response: ModelResponse) => void;
  onCompaction: (
    state: 'started' | 'finished' | 'failed',
    covered?: number,
    usage?: Usage,
    reason?: string,
  ) => void;
  forceCompact?: boolean;
  /**
   * Skip a threshold-triggered compaction because a recent attempt failed. A request that no longer
   * fits is still compressed.
   */
  deferThresholdCompaction?: boolean;
  /**
   * Compressions already paid for in this call, so the convergence retry can re-enter and re-read
   * the surface.
   */
  compactionAttempt?: number;
  /**
   * What an unperformable compaction means. `'throw'` (default) suits an explicit compact request.
   * A run uses `'send'`: the estimate is a heuristic and the endpoint decides whether the request
   * fits (see `PreparedContext.compactionProblem` and `recoverFromOverflow`).
   */
  compactionFailure?: 'throw' | 'send';
  /**
   * The model this round aims at, recorded with the compaction so the summary is reconstructible.
   */
  model?: string;
  /**
   * The wire adapter for this round (`anthropic`, `openai`, `openai-responses`), recorded with the
   * model. Named `protocol` because `provider` here is the adapter object.
   */
  protocol?: string;
}): Promise<PreparedContext> {
  const { store, sessionId, limit } = input;
  /**
   * This route's learned correction: `factors()` are per-part weights for `measureRequest`;
   * `messageWeight()` is the single weight for message-only measures.
   */
  const factors = () => input.calibration?.parts;
  const messageWeight = () => input.calibration?.factor ?? 1;
  const history = store.messages(sessionId);
  /**
   * The surface the log's last compaction defines: the summary and the tail cut point. Compaction
   * continues cumulatively from it, whoever recorded it.
   */
  const surface = store.contextSurface(sessionId);
  const previouslyCovered = surface?.coveredMessages ?? 0;
  const previousSummary = surface?.summary ?? '';
  let covered = previouslyCovered;
  let summary = previousSummary;
  /**
   * The last batch's raw answer, when storing changed it. Earlier batches are already folded into
   * it.
   */
  let rawOutput: string | undefined;
  /**
   * Sized in the same shape it is sent: constant system prompt, tool catalogue, then messages with
   * the running summary in front.
   */
  // The catalogue does not change during one assembly, and it was serialised again for every size asked.
  const toolChars = JSON.stringify(input.tools).length;
  const size = (messages: Message[]) =>
    input.system.length + toolChars + contextMessageSize(withSummary(messages, summary));
  const charsFit = (messages: Message[]) => size(messages) <= limit;
  const forecastOf = (messages: Message[]): RequestForecast =>
    forecastRequest({
      system: input.system,
      messages: withSummary(messages, summary),
      tools: input.tools,
      maxOutputTokens: input.maxOutputTokens,
      maxContextTokens: input.maxContextTokens,
      ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
    });
  const toolResults = projectToolResults(store, sessionId, history, covered, input.runId);
  const current = toolResults.messages;
  /**
   * The compression policy for this round, when a window is known. Output reservation and headroom
   * come off the window first; `autoCompactTokens`, if set, replaces the computed threshold. A
   * window too small for the reservation is reported in `policyProblem` rather than thrown, and
   * compression then waits until the request stops fitting.
   */
  let spec: ReturnType<typeof resolveCompactionSpec> | undefined;
  let policyProblem: string | undefined;
  if (input.maxContextTokens !== undefined) {
    try {
      spec = resolveCompactionSpec({
        contextWindow: input.maxContextTokens,
        reservedCompletionTokens: input.maxOutputTokens,
        ...(input.autoCompactTokens === undefined
          ? {}
          : { thresholdTokens: input.autoCompactTokens }),
      });
    } catch (error) {
      policyProblem = error instanceof Error ? error.message : String(error);
    }
  }
  /** Spread into every return, so a caller cannot get a prepared context that hides a broken policy. */
  const policyNote = {
    ...(policyProblem === undefined ? {} : { policyProblem }),
    ...(spec === undefined ? {} : { maxOverflowRetries: spec.maxOverflowRetries }),
  };
  /** The ceiling a request is measured against: the window itself, with room left to answer. */
  const compactWindow = spec?.thresholdTokens ?? input.maxContextTokens;
  const fits = (messages: Message[], forecast: RequestForecast) =>
    charsFit(messages) && forecast.problem === undefined;
  const aboveThreshold = (forecast: RequestForecast): boolean =>
    spec !== undefined && forecast.inputTokens >= spec.thresholdTokens;
  const summaryOutputBudget = () =>
    Math.min(input.maxOutputTokens, Math.max(64, Math.floor(limit / 8)));
  // Reserve room for a useful summary plus reasoning (up to 1024 tokens) before choosing a batch. A
  // smaller operator output cap still wins.
  const SUMMARY_MIN_OUTPUT_TOKENS = Math.min(1024, summaryOutputBudget());
  /**
   * Whether one summary batch can be sent, measured as the real request (main system prompt, the
   * same tool schemas, the batch and the instruction) against the model's window, not the round's
   * output reserve.
   */
  const fitsSummary = (transcript: Message[]): boolean => {
    const predicted = forecastRequest({
      system: input.system,
      // The transcript already carries the running summary (`summaryTranscript`); do not wrap it
      // again.
      messages: transcript,
      tools: input.tools,
      maxOutputTokens: summaryOutputBudget(),
      maxContextTokens: input.maxContextTokens,
      ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
    });
    return predicted.problem === undefined && predicted.outputTokens >= SUMMARY_MIN_OUTPUT_TOKENS;
  };
  /** The same request against the character budget, the other ceiling a batch has to clear before it is sent. */
  const summaryCharsFit = (transcript: Message[]): boolean =>
    input.system.length + toolChars + contextMessageSize(transcript) <= limit;
  /**
   * Shorten old tool results on a copy and report the saving; the stored transcript is untouched.
   */
  const shorten = (
    messages: Message[],
  ): { messages: Message[]; shortened: number; freed: number } => {
    if (!input.shrink) return { messages, shortened: 0, freed: 0 };
    const outcome = shortenMessages(
      messages,
      input.shrink.policy,
      input.shrink.spill,
      input.shrink.measure,
      toolResults.preserved,
    );
    return { messages: outcome.messages, shortened: outcome.shortened, freed: outcome.freedChars };
  };
  /**
   * Drop the middle of oversized old tool results and report the saving. Runs after shortening;
   * already shortened results are too small to be pruned.
   */
  const prune = (messages: Message[]): PruneOutcome => {
    if (!input.prune) return { messages, pruned: 0, prunedChars: 0 };
    assertPrunePolicy(input.prune.policy);
    return pruneMessages(
      messages,
      input.prune.policy,
      input.prune.keepRecent,
      toolResults.preserved,
    );
  };
  let forecast = forecastOf(current);
  let visible = current;
  let shortened = 0;
  let freedChars = 0;
  let pruned = 0;
  let prunedChars = 0;
  /** What the summary requests of this call cost, so a checkpoint records it instead of the cost vanishing. */
  const compactionUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  /**
   * `compactionStarted` is set once a summary is actually attempted, so refusals before that are
   * not reported as failed compactions. `compactionSettled` ensures an announced compaction ends
   * exactly once.
   */
  let compactionStarted = false;
  let compactionSettled = false;
  const settleCompaction = (
    state: 'finished' | 'failed',
    coveredMessages?: number,
    usage?: Usage,
    reason?: string,
  ): void => {
    if (!compactionStarted || compactionSettled) return;
    compactionSettled = true;
    input.onCompaction(state, coveredMessages, usage, reason);
  };
  /**
   * The compaction did not happen: throw, or return the uncompacted request with
   * `compactionProblem` set. The store is untouched on these paths, except after a convergence
   * retry, which returns its own surface.
   */
  const abandonCompaction = (failure: Error): PreparedContext => {
    /**
     * Restore the surface this call started from: nothing was written, so the view must match the
     * store's summary, tail and a recomputed forecast.
     */
    summary = previousSummary;
    rawOutput = undefined;
    const restored = forecastOf(visible);
    settleCompaction('failed', previouslyCovered, compactionUsage, failure.message);
    /** The operator's `--max-context-chars` cap is a hard limit, unlike the token estimate. */
    if (!charsFit(visible) || (input.compactionFailure ?? 'throw') === 'throw') throw failure;
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast: restored,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      compactionProblem: failure.message,
      ...policyNote,
    };
  };
  /**
   * The shared summary deadline ran out. Separated from a user cancellation, which must never send
   * the request.
   */
  const summaryDeadline = (): PreparedContext => {
    if (input.signal.aborted) throw input.signal.reason;
    return abandonCompaction(new Error('Context summary timeout; history was preserved'));
  };
  // Shorten first (no model request, keeps the conversation's shape); compress only if that is not
  // enough.
  /**
   * Whether the request fits as it stands, memoised per conversation state since each check
   * serialises every tool schema.
   */
  let fitsAsIs: boolean | undefined;
  const fitsOnce = (): boolean => (fitsAsIs ??= fits(visible, forecast));
  if (
    input.shrink &&
    (!fitsOnce() || windowPressure(forecast, compactWindow, input.shrinkPercent ?? 100))
  ) {
    const applied = shorten(visible);
    if (applied.shortened) {
      visible = applied.messages;
      shortened += applied.shortened;
      freedChars += applied.freed;
      forecast = forecastOf(visible);
      fitsAsIs = undefined;
    }
  }
  /**
   * Prune what shortening could not help, under the same condition, but gated on the
   * post-shortening fit so the passes never rewrite the same message.
   */
  if (
    input.prune &&
    (!fitsOnce() || windowPressure(forecast, compactWindow, input.prunePercent ?? 100))
  ) {
    const applied = prune(visible);
    if (applied.pruned) {
      visible = applied.messages;
      pruned += applied.pruned;
      prunedChars += applied.prunedChars;
      forecast = forecastOf(visible);
      fitsAsIs = undefined;
    }
  }
  toolResults.remember(visible);
  const fitsNow = fitsOnce();
  /**
   * Compress at the threshold (while the summary request still fits), when the request no longer
   * fits (e.g. after one huge tool result), or on request.
   */
  const compacting =
    input.forceCompact === true ||
    !fitsNow ||
    (aboveThreshold(forecast) && input.deferThresholdCompaction !== true);
  if (!compacting) {
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      ...policyNote,
    };
  }
  /**
   * The turn cannot proceed: it exceeds the window and there is nothing left to compress. Same
   * verdict as a pre-send refusal.
   */
  const turnFailure = () =>
    new ContextLimitError(
      'Current turn exceeds context budget; start a new session with a smaller task',
    );
  /**
   * A forced compression needs a completed turn. A fresh session with only a prompt and runtime
   * announcements has nothing to summarize, so report that directly.
   */
  if (
    input.forceCompact &&
    !history.some((message) => message.role === 'assistant' || message.role === 'tool')
  )
    return abandonCompaction(turnFailure());
  const cuts = contextBoundaries(history);
  /**
   * How much of the newest conversation stays verbatim: the policy's share, or nothing for a forced
   * compression. Without a window, keep from the last user turn.
   */
  const retainTokens = input.forceCompact ? 0 : (spec?.retainTokens ?? 0);
  /**
   * Measured with this route's `messageWeight()` so the retained share is in the endpoint's billed
   * tokens.
   */
  const retained =
    spec === undefined
      ? undefined
      : retentionStart(history, cuts, covered, retainTokens, messageWeight());
  let boundary = input.forceCompact ? (cuts.at(-1) ?? 0) : (retained ?? history.length - 1);
  if (input.forceCompact && boundary <= covered)
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      ...policyNote,
    };
  // Legacy boundary rule: without a policy the tail starts at a user turn, so the conversation keeps its shape.
  if (!input.forceCompact && retained === undefined)
    while (boundary >= covered && history[boundary]?.role !== 'user') boundary--;
  const overhead = input.system.length + toolChars;
  // Boundary selection runs before any summary or calibration update, so its views and forecasts
  // can be reused here; after summarizing, forecast anew.
  const boundaryViews = new Map<number, { messages: Message[]; forecast?: RequestForecast }>();
  const boundaryView = (cut: number) => {
    let view = boundaryViews.get(cut);
    if (!view) {
      view = { messages: toolResults.tail(cut) };
      boundaryViews.set(cut, view);
    }
    return view;
  };
  const boundaryForecast = (cut: number) => {
    const view = boundaryView(cut);
    return (view.forecast ??= forecastOf(view.messages));
  };
  if (
    boundary <= covered ||
    overhead + contextMessageSize(boundaryView(boundary).messages) > limit ||
    !fits(boundaryView(boundary).messages, boundaryForecast(boundary))
  ) {
    // A long single task may compact completed tool steps too; keep the original user request and
    // the newest complete step where possible. Fitting tails are found by bisection
    // (`./boundary-search.ts`).
    const candidates = cuts.filter((cut) => cut > covered && cut > 0);
    const first = firstHolding(
      candidates.length,
      (index) =>
        overhead + contextMessageSize(boundaryView(candidates[index]!).messages) < limit * 0.65 &&
        fits(boundaryView(candidates[index]!).messages, boundaryForecast(candidates[index]!)),
    );
    boundary = first < 0 ? -1 : candidates[first]!;
  }
  if (boundary < 1 || (boundary === history.length && history.length === 1))
    return abandonCompaction(turnFailure());
  const tail = boundaryView(boundary).messages;
  const tailForecast = boundaryForecast(boundary);
  if (!fits(tail, tailForecast)) {
    // A tail of all-recent messages can still be over the ceiling; shortening it beats failing the
    // run.
    const applied = shorten(tail);
    if (applied.shortened) {
      shortened += applied.shortened;
      freedChars += applied.freed;
      const appliedForecast = forecastOf(applied.messages);
      if (fits(applied.messages, appliedForecast)) {
        toolResults.remember(applied.messages, tail);
        return {
          system: input.system,
          messages: withSummary(applied.messages, summary),
          forecast: appliedForecast,
          shortened,
          freedChars,
          pruned,
          prunedChars,
          compacted: false,
          ...policyNote,
        };
      }
    }
    /**
     * Last resort for a tail shortening could not fix: prune, which needs nothing from the host.
     */
    const dropped = prune(tail);
    if (dropped.pruned) {
      pruned += dropped.pruned;
      prunedChars += dropped.prunedChars;
      const droppedForecast = forecastOf(dropped.messages);
      if (fits(dropped.messages, droppedForecast)) {
        toolResults.remember(dropped.messages, tail);
        return {
          system: input.system,
          messages: withSummary(dropped.messages, summary),
          forecast: droppedForecast,
          shortened,
          freedChars,
          pruned,
          prunedChars,
          compacted: false,
          ...policyNote,
        };
      }
    }
    // The verdict concerns the remaining tail, which is already as small as it gets.
    return abandonCompaction(new ContextLimitError(WINDOW_EXHAUSTED));
  }
  /**
   * The compaction lock (`SessionStore.claimCompaction`), taken before the first summary request so
   * no request is spent on a write that would be refused.
   */
  store.claimCompaction(sessionId, input.runId);
  /**
   * Whether the lock was handed to this call's own retry. The retry re-claims synchronously before
   * this call's `finally` runs, so this call must not release it.
   */
  let handedOff = false;
  try {
    compactionStarted = true;
    input.onCompaction('started');
    // Summarize complete old turns in bounded batches; persist only after every batch succeeds.
    let summaryCacheKnown = true;
    const summarySignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.summaryTimeoutMs),
    ]);
    let retriesLeft = 1;
    /**
     * Set after a summary answered with a tool call: retry once with tool calls forbidden (the
     * catalogue is sent only for the cache prefix).
     */
    let forbidTools = false;
    while (covered < boundary) {
      input.signal.throwIfAborted();
      let end = covered;
      let batch: Message[] = [];
      // `cuts` is ascending and unique, and a longer batch never fits where a shorter one did not,
      // so the batch end is found by bisection.
      const range = cuts.filter((candidate) => candidate > covered && candidate <= boundary);
      const last = lastHolding(range.length, (index) => {
        /**
         * The batch exactly as the main request sends it: any rewrite would break the shared cache
         * prefix and describe a different conversation.
         */
        const transcript = summaryTranscript(history.slice(covered, range[index]!), summary);
        return summaryCharsFit(transcript) && fitsSummary(transcript);
      });
      if (last >= 0) {
        end = range[last]!;
        batch = history.slice(covered, end);
      }
      if (end === covered)
        return abandonCompaction(
          new ContextLimitError(
            'An earlier turn is too large to summarize within the context budget; history was preserved',
          ),
        );
      let response: ModelResponse;
      for (;;) {
        if (summarySignal.aborted) return summaryDeadline();
        const transcript = summaryTranscript(batch, summary);
        /**
         * Read once per batch so the estimate, forecast, request and cache key use the same bytes.
         */
        const summarySystem = input.system;
        const rawSummaryEstimate = estimateInputTokens(summarySystem, transcript, input.tools);
        /**
         * Forecast the summary request like any model request; `fitsSummary` already chose the
         * batch.
         */
        const summaryForecast = forecastRequest({
          system: summarySystem,
          messages: transcript,
          tools: input.tools,
          maxOutputTokens: summaryOutputBudget(),
          maxContextTokens: input.maxContextTokens,
          ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
        });
        const summaryCacheKey = input.cacheKeyFor?.(summarySystem, input.tools);
        try {
          response = await input.provider.complete({
            // Replay the main request's prefix; only the final instruction is new.
            system: summarySystem,
            messages: transcript,
            tools: input.tools,
            ...(summaryCacheKey === undefined ? {} : { cacheKey: summaryCacheKey }),
            ...(forbidTools ? { toolChoice: 'none' as const } : {}),
            maxOutputTokens: summaryForecast.outputTokens,
            signal: summarySignal,
            onText: () => {},
          });
        } catch (error) {
          /**
           * A failed summary request is a compaction that did not happen, handled per
           * `compactionFailure`. A cancelled run rethrows: Stop must never send the request.
           */
          if (input.signal.aborted) throw error;
          /** Name the deadline explicitly; the adapter only reports an abort. */
          if (summarySignal.aborted) return summaryDeadline();
          return abandonCompaction(error instanceof Error ? error : new Error(String(error)));
        }
        if (summarySignal.aborted) return summaryDeadline();
        compactionUsage.inputTokens += response.usage.inputTokens;
        compactionUsage.outputTokens += response.usage.outputTokens;
        if (response.usage.inputTokens > 0 && response.usage.cachedInputTokens === undefined)
          summaryCacheKnown = false;
        if (response.usage.cachedInputTokens !== undefined)
          compactionUsage.cachedInputTokens =
            (compactionUsage.cachedInputTokens ?? 0) + response.usage.cachedInputTokens;
        if (response.usage.cacheWriteInputTokens !== undefined)
          compactionUsage.cacheWriteInputTokens =
            (compactionUsage.cacheWriteInputTokens ?? 0) + response.usage.cacheWriteInputTokens;
        // Summary requests use the same model, so their usage calibrates the main estimate too.
        input.calibration?.observe(rawSummaryEstimate, response.usage.inputTokens);
        input.onUsage(response);
        if (response.finishReason === 'length' && retriesLeft > 0) {
          const smaller = cuts.filter((cut) => cut > covered && cut < end);
          const retryEnd = smaller
            .slice(0, Math.floor(smaller.length / 2) + 1)
            .reverse()
            .find((cut) => fitsSummary(summaryTranscript(history.slice(covered, cut), summary)));
          if (retryEnd !== undefined) {
            retriesLeft--;
            const details = {
              attempt: 1,
              fromMessages: batch.length,
              toMessages: retryEnd - covered,
              finishReason: response.finishReason,
              outputTokens: response.usage.outputTokens,
            };
            store.recordEvent(sessionId, 'context.summary.retry', {
              ...(input.runId ? { runId: input.runId } : {}),
              ...details,
            });
            input.onSummaryRetry?.(details);
            end = retryEnd;
            batch = history.slice(covered, end);
            continue;
          }
        }
        if (response.toolCalls.length && !forbidTools) {
          forbidTools = true;
          continue;
        }
        if (response.finishReason !== 'stop' || response.toolCalls.length || !response.text.trim())
          return abandonCompaction(
            new Error(
              'Context summary was incomplete (finish_reason=' +
                response.finishReason +
                ', output_tokens=' +
                response.usage.outputTokens +
                ', reasoning_tokens=' +
                (response.outputDiagnostics?.reasoningTokens ?? 'unknown') +
                ', tool_calls=' +
                response.toolCalls.length +
                '); history was preserved',
            ),
          );
        break;
      }
      const rawSummaryText = response.text;
      const merged = storedSummary(rawSummaryText);
      /**
       * The raw answer, kept only when storing changed it; absent means the stored summary is
       * verbatim.
       */
      rawOutput = rawSummaryText === merged ? undefined : rawSummaryText;
      if (!merged)
        return abandonCompaction(
          new Error('Context summary was incomplete; history was preserved'),
        );
      summary = merged;
      if (summary.length > Math.floor(limit / 3))
        return abandonCompaction(
          new ContextLimitError(
            'Context summary is too large to stand in for the conversation; history was preserved',
          ),
        );
      covered = end;
    }
    /**
     * Compare the surface before and after (summary plus tail). A summary that costs more than it
     * replaces is refused, and this is checked before the window so the cause is named.
     */
    const replacedChars =
      previousSummary.length + contextMessageSize(history.slice(previouslyCovered));
    const surfaceChars = summary.length + contextMessageSize(history.slice(covered));
    if (surfaceChars >= replacedChars)
      return abandonCompaction(
        new ContextLimitError(
          'Context summary did not shrink the conversation; history was preserved',
        ),
      );
    const finalForecast = forecastOf(tail);
    if (!fits(tail, finalForecast))
      return abandonCompaction(
        new ContextLimitError(
          'Summary and current turn exceed context budget; history was preserved',
        ),
      );
    store.applyCompaction(sessionId, {
      coveredMessages: covered,
      summary,
      usage: compactionUsage,
      cacheKnown: summaryCacheKnown,
      replacedChars,
      surfaceChars,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      // The summary's protocol, model and output budget; the prompt and catalogue are in the
      // round's `context.envelope`.
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.model === undefined ? {} : { model: input.model }),
      maxTokens: summaryOutputBudget(),
      ...(rawOutput === undefined ? {} : { rawOutput }),
    });
    settleCompaction('finished', covered, compactionUsage);
    /**
     * Convergence: compress again while still above the threshold and the policy allows another
     * attempt. The re-entry re-reads the recorded surface. Forced compressions never re-enter. The
     * lock is released first and re-claimed by the retry; `handedOff` keeps the `finally` below
     * from clearing it.
     */
    const attempt = input.compactionAttempt ?? 0;
    if (
      spec !== undefined &&
      input.forceCompact !== true &&
      finalForecast.inputTokens >= spec.thresholdTokens &&
      attempt < spec.compactionRetries
    ) {
      handedOff = true;
      store.releaseCompaction(sessionId, input.runId);
      return prepareContext({ ...input, compactionAttempt: attempt + 1 });
    }
    return {
      system: input.system,
      messages: withSummary(tail, summary),
      forecast: finalForecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: true,
      ...policyNote,
    };
  } finally {
    /**
     * Release the lock on every exit, including throws, except after handing it to a retry
     * (`handedOff`).
     */
    if (!handedOff) store.releaseCompaction(sessionId, input.runId);
  }
}
