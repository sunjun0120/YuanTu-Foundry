import { RunFailure } from '../../protocol/failure.ts';
import type { ModelProgress, ModelResponse, Provider, Usage } from '../../protocol/index.ts';
import type {
  PreparedRequestFingerprint,
  RequestFingerprint,
} from '../../protocol/request-cache.ts';
import { compareRequestFingerprint, readRequestFingerprint } from '../context/request-cache.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { addUsage, emptyRequestTiming } from '../../protocol/statistics.ts';
import type { RunEmit } from './emit.ts';

/**
 * The provider wrapper every model call of a run goes through, so answer calls and compaction
 * summaries are measured alike.
 *
 * - One `provider.request.finished` per attempt, with request id, purpose, duration and failure.
 * - `statistics.requestTiming`, mutated in place because emitted frames share the object.
 * - A throttled `statistics.updated` while progress arrives (at most once a second per phase; a new
 *   phase's first frame always goes out).
 * - A closing `statistics.updated` with `activity: null`, even on failure.
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
  const baselines = (): Map<string, RequestFingerprint> => {
    const previous = new Map<string, RequestFingerprint>();
    const latest = store.newestPayload(sessionId, 'provider.request.finished');
    const saved = latest?.cacheBaselines as Record<string, unknown> | undefined;
    for (const purpose of ['answer', 'summary']) {
      const restored = readRequestFingerprint(saved?.[purpose]);
      if (restored) previous.set(purpose, restored);
    }
    const restored = readRequestFingerprint(latest?.fingerprint);
    if (restored && (latest?.purpose === 'answer' || latest?.purpose === 'summary'))
      previous.set(latest.purpose, restored);
    return previous;
  };
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
      let requestUsage: Usage | undefined;
      let fingerprint: PreparedRequestFingerprint | undefined;
      let failed = false;
      let discarded: 'tool-arguments-dropped' | undefined;
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
          onRequestFingerprint: (prepared) => {
            fingerprint = prepared;
            request.onRequestFingerprint?.(prepared);
          },
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
        requestUsage = response.usage;
        if (finishReason === 'length') timing.lengthCount++;
        addUsage(statistics, response.usage);
        return response;
      } catch (error) {
        failed = true;
        timing.failedRequests++;
        if (error instanceof RunFailure && error.details?.usage) {
          if (error.code === 'tool-arguments-dropped') discarded = error.code;
          requestUsage = error.details.usage;
          finishReason = error.details.finishReason;
          error.details.requestNumber = requestId;
          addUsage(statistics, requestUsage);
        } else statistics.usageComplete = false;
        throw error;
      } finally {
        const durationMs = Math.max(0, performance.now() - requestStarted);
        timing.providerMs += durationMs;
        if (purpose === 'summary') timing.summaryMs += durationMs;
        if (failed) timing.failedMs += durationMs;
        // Answer and separate-summary wrappers share this durable, bounded owner. Reading it here avoids
        // overwriting a newer baseline from another wrapper with a snapshot taken at run start.
        const previous = baselines();
        const cache = fingerprint
          ? compareRequestFingerprint(fingerprint, previous.get(purpose))
          : undefined;
        if (cache) previous.set(purpose, cache.fingerprint);
        const knownCache = requestUsage?.cachedInputTokens;
        const validCache =
          requestUsage !== undefined &&
          knownCache !== undefined &&
          Number.isSafeInteger(knownCache) &&
          knownCache >= 0 &&
          knownCache <= requestUsage.inputTokens;
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
          ...(discarded ? { discarded } : {}),
          ...(request.degradedFrom === undefined ? {} : { degradedFrom: request.degradedFrom }),
          ...(finishReason ? { finishReason } : {}),
          ...(requestUsage ? { usage: { ...requestUsage } } : {}),
          ...(validCache
            ? {
                cacheMissInputTokens: requestUsage!.inputTokens - knownCache!,
                ...(requestUsage!.inputTokens > 0
                  ? { cacheHitRatio: knownCache! / requestUsage!.inputTokens }
                  : {}),
              }
            : {}),
          ...cache,
          ...(previous.size ? { cacheBaselines: Object.fromEntries(previous) } : {}),
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
