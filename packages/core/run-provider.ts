import type { ModelProgress, ModelResponse, Provider } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { addUsage, emptyRequestTiming } from '../protocol/statistics.ts';
import type { RunEmit } from './run-emit.ts';

/**
 * The provider wrapper every model call of a run goes through, and the accounting it produces.
 *
 * Two purposes share one wrapper because the numbers have to be comparable: the run's own answer calls and the
 * summary calls a compaction makes are measured by the same clock and recorded as the same kind of fact, which is
 * what lets a reader ask "how much of this run's wall time was the provider?" and get an answer that includes the
 * summaries rather than one that quietly omits them.
 *
 * What is recorded, and why each piece exists:
 *
 * - **One `provider.request.finished` per attempt**, carrying the request id, its purpose, its duration and
 *   whether it failed. Retries mean more than one of these per step, and the id is what pairs an attempt with
 *   the request that produced it.
 * - **`statistics.requestTiming`**, folded in place: request counts, summary counts, provider time, failed time,
 *   `length` finishes. It is mutated rather than rebuilt because it is the same object the emitted frames carry
 *   and the run's final statistics are built from.
 * - **A throttled `statistics.updated` frame while progress arrives** (at most once a second per phase). A
 *   provider that reports progress per token would otherwise make the frame rate the client sees depend on the
 *   model's verbosity; the first frame of a new phase is always sent, so a phase change is never swallowed.
 * - **A closing `statistics.updated` with `activity: null`**, so a client that draws "the model is thinking"
 *   stops drawing it even when the request failed.
 */
export interface ProviderMeasurementOptions {
  provider: Provider;
  store: SessionStore;
  sessionId: string;
  runId: string;
  statistics: SessionStatistics;
  emit: RunEmit;
  admittedAt?: number;
}

export function createProviderMeasurement(
  options: ProviderMeasurementOptions,
): (purpose: 'answer' | 'summary') => Provider {
  const { provider, store, sessionId, runId, statistics, emit } = options;
  let firstAnswer = true;
  return (purpose) => ({
    complete: async (request) => {
      const startedAt = Date.now();
      const requestStarted = performance.now();
      const preparationMs =
        purpose === 'answer' && firstAnswer && options.admittedAt !== undefined
          ? Math.max(0, startedAt - options.admittedAt)
          : undefined;
      if (purpose === 'answer') firstAnswer = false;
      let firstResponseMs: number | null = null;
      let firstTextMs: number | null = null;
      const responseArrived = () => {
        firstResponseMs ??= Math.max(0, performance.now() - requestStarted);
      };
      const timing = (statistics.requestTiming ??= emptyRequestTiming());
      const requestId = ++timing.requests;
      if (purpose === 'summary') timing.summaryRequests++;
      let finishReason: ModelResponse['finishReason'] | undefined;
      let failed = false;
      let lastPhase = '';
      let lastProgressAt = 0;
      let reasoningChars = 0;
      let visibleChars = 0;
      const publishActivity = (progress: ModelProgress) => {
        const now = Date.now();
        if (progress.phase === lastPhase && now - lastProgressAt < 1000) return;
        lastPhase = progress.phase;
        lastProgressAt = now;
        emit('statistics.updated', {
          statistics: { ...statistics },
          activity: { kind: 'model', startedAt, ...progress },
        });
      };
      emit('statistics.updated', {
        statistics: { ...statistics },
        activity: { kind: 'model', startedAt },
      });
      try {
        const response = await provider.complete({
          ...request,
          onText: (delta) => {
            if (delta) {
              responseArrived();
              firstTextMs ??= Math.max(0, performance.now() - requestStarted);
            }
            request.onText(delta);
            if (delta) {
              visibleChars += delta.length;
              publishActivity({
                phase: 'text',
                visibleChars,
                reasoningChars,
                toolArgumentChars: 0,
              });
            }
          },
          onReasoning: (delta) => {
            if (delta) responseArrived();
            request.onReasoning?.(delta);
            if (delta) {
              reasoningChars += delta.length;
              publishActivity({
                phase: 'reasoning',
                visibleChars,
                reasoningChars,
                toolArgumentChars: 0,
              });
            }
          },
          onProgress: (progress) => {
            if (progress.reasoningChars || progress.toolArgumentChars || progress.visibleChars)
              responseArrived();
            request.onProgress?.(progress);
            publishActivity(progress);
          },
        });
        finishReason = response.finishReason;
        if (finishReason === 'length') timing.lengthCount++;
        addUsage(statistics, response.usage);
        return response;
      } catch (error) {
        failed = true;
        timing.failedRequests++;
        statistics.usageComplete = false;
        throw error;
      } finally {
        const durationMs = Math.max(0, performance.now() - requestStarted);
        timing.providerMs += durationMs;
        if (purpose === 'summary') timing.summaryMs += durationMs;
        if (failed) timing.failedMs += durationMs;
        const measurement = {
          requestId,
          purpose,
          startedAt,
          finishedAt: Date.now(),
          durationMs,
          firstResponseMs,
          firstTextMs,
          ...(preparationMs === undefined ? {} : { preparationMs }),
          failed,
          ...(finishReason ? { finishReason } : {}),
        };
        store.recordEvent(sessionId, 'provider.request.finished', {
          runId,
          ...measurement,
        });
        emit('provider.request.finished', measurement);
        // Legacy modelMs is still closed only when a step assembles an answer.
        emit('statistics.updated', { statistics: { ...statistics }, activity: null });
      }
    },
  });
}
