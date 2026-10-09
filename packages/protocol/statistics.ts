import type { Usage } from './index.ts';
/**
 * What a session has spent and how long it took, in the shape DSH's session panel reads.
 *
 * Every figure here is defined the way the DSH harness defines it, because the desktop shows these numbers
 * next to DSH's own and two answers to "how long did the model take" would be worse than one:
 *
 * - `modelMs` is the *step's* wall time (`step/start` → the assembled answer), not the provider call's. A
 *   round that retried its request, or spent time building a request before sending it, is one step and one
 *   span, and a step that assembled no answer — a cancellation or a failure mid-stream — contributes no span
 *   at all rather than a partial one.
 * - `firstTokenMs` counts from the step's start to the step's first visible text, so it survives a retry
 *   inside the step exactly as the span does.
 * - `decodeMs` starts at visible body text. `decodeTokens` excludes reported reasoning and only counts
 *   text-only answers with a known usage split. Throughput is available only when `decodeKnown` is true.
 * - `toolMs` pairs a tool call with its result, so it includes any approval wait in between.
 * - `turns`/`steps` are the session's closed boundaries. A run is one turn, and a run that closed no step
 *   contributes no turn — which is what makes the counts agree with a reloaded log instead of only with a
 *   process that happened to be watching.
 *
 * `cacheKnown`, `timingKnown` and `usageComplete` say whether the provider ever failed to report part of
 * what these totals are made of. They are recorded rather than inferred, and they survive the reload because
 * the run's own result carries them.
 */
export interface SessionStatistics {
  /** Request-level spans, independent of the legacy completed-step wall time. */
  requestTiming?: RequestTiming;
  /** Distinct runs that closed at least one step. */
  turns: number;
  /** Closed steps (`step.finished`) — completed, failed and cancelled steps alike. */
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Input tokens written into the provider's prompt cache; part of `inputTokens`, reported separately. */
  cacheWriteInputTokens: number;
  cacheKnown: boolean;
  timingKnown: boolean;
  usageComplete: boolean;
  /** Summed step wall time (`step.started` → assembled answer) over steps that assembled one. */
  modelMs: number;
  toolMs: number;
  /** Summed first-token latency over `firstTokenCount`. */
  firstTokenMs: number;
  /** Steps carrying a recorded first token. */
  firstTokenCount: number;
  /** Summed decode wall time (first token → assembled answer) over steps that reported output tokens. */
  decodeMs: number;
  /** Known visible body tokens; never inferred from an unsplit output total. */
  decodeTokens: number;
  /** False if any timed answer lacks a body usage split; absent in legacy logs. */
  decodeKnown?: boolean;
}
export interface RequestTiming {
  /** All provider calls, including summaries and rejected/failed attempts. */
  requests: number;
  providerMs: number;
  /** Summary calls are a subset of providerMs/requests. */
  summaryRequests: number;
  summaryMs: number;
  /** Calls that threw, including cancelled calls; a subset of providerMs. */
  failedRequests: number;
  failedMs: number;
  /** Actual time waiting between attempts; excludes provider work. */
  retryWaitMs: number;
  lengthCount: number;
}
export function emptyRequestTiming(): RequestTiming {
  return {
    requests: 0,
    providerMs: 0,
    summaryRequests: 0,
    summaryMs: 0,
    failedRequests: 0,
    failedMs: 0,
    retryWaitMs: 0,
    lengthCount: 0,
  };
}
export function emptyStatistics(): SessionStatistics {
  return {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheKnown: true,
    timingKnown: true,
    usageComplete: true,
    modelMs: 0,
    toolMs: 0,
    firstTokenMs: 0,
    firstTokenCount: 0,
    decodeMs: 0,
    decodeTokens: 0,
  };
}
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
] as const;
const TIMING_FIELDS = ['modelMs', 'toolMs', 'firstTokenMs', 'decodeMs'] as const;
const COUNT_FIELDS = ['turns', 'steps', 'firstTokenCount', 'decodeTokens'] as const;
const LEGACY_OPTIONAL_FIELDS = new Set<string>([
  'turns',
  'steps',
  'decodeMs',
  'decodeTokens',
  'cacheWriteInputTokens',
]);
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const validNumber = (value: unknown, integer = true): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER &&
  (!integer || Number.isSafeInteger(value));

/** Checkpoint readers must refuse invalid totals and replay the log instead of trusting poisoned cache data. */
export function isSessionStatistics(value: unknown): value is SessionStatistics {
  const record = recordOf(value);
  if (!record) return false;
  for (const key of [...USAGE_FIELDS, ...TIMING_FIELDS, ...COUNT_FIELDS]) {
    if (record[key] === undefined && LEGACY_OPTIONAL_FIELDS.has(key)) continue;
    if (!validNumber(record[key], !(TIMING_FIELDS as readonly string[]).includes(key)))
      return false;
  }
  if (typeof record.cacheKnown !== 'boolean' || typeof record.timingKnown !== 'boolean')
    return false;
  for (const key of ['usageComplete', 'decodeKnown'])
    if (record[key] !== undefined && typeof record[key] !== 'boolean') return false;
  if (record.requestTiming !== undefined) {
    const timing = recordOf(record.requestTiming);
    if (!timing) return false;
    for (const key of Object.keys(emptyRequestTiming()))
      if (!validNumber(timing[key], !key.endsWith('Ms'))) return false;
  }
  return true;
}

export function addUsage(target: SessionStatistics, usage: Usage): void {
  const record = recordOf(usage) ?? {};
  for (const key of USAGE_FIELDS) {
    const value = record[key];
    const optional = key === 'cachedInputTokens' || key === 'cacheWriteInputTokens';
    if (value === undefined && optional) continue;
    if (!validNumber(value)) {
      target.usageComplete = false;
      if (key === 'cachedInputTokens') target.cacheKnown = false;
      continue;
    }
    const sum = target[key] + value;
    target[key] = Math.min(sum, Number.MAX_SAFE_INTEGER);
    if (!validNumber(sum)) target.usageComplete = false;
  }
  if (
    validNumber(record.inputTokens) &&
    record.inputTokens > 0 &&
    record.cachedInputTokens === undefined
  )
    target.cacheKnown = false;
}

/** Preserve known measurements from partial legacy or malformed payloads without coercing unknown numbers. */
export function normalizeStatistics(value: unknown): SessionStatistics {
  const record = recordOf(value) ?? {};
  const clean = emptyStatistics();
  addUsage(clean, record as unknown as Usage);
  clean.cacheKnown &&= record.cacheKnown === true;
  clean.timingKnown = record.timingKnown === true;
  clean.usageComplete &&= record.usageComplete === undefined || record.usageComplete === true;
  for (const key of [...TIMING_FIELDS, ...COUNT_FIELDS]) {
    if (record[key] === undefined && LEGACY_OPTIONAL_FIELDS.has(key)) continue;
    if (validNumber(record[key], !(TIMING_FIELDS as readonly string[]).includes(key)))
      clean[key] = record[key];
    else clean.timingKnown = false;
  }
  if (record.decodeKnown !== undefined) clean.decodeKnown = record.decodeKnown === true;
  if (record.decodeMs !== undefined && !validNumber(record.decodeMs, false))
    clean.decodeKnown = false;
  if (record.decodeTokens !== undefined && !validNumber(record.decodeTokens))
    clean.decodeKnown = false;
  if (record.requestTiming !== undefined) {
    const timing = recordOf(record.requestTiming) ?? {};
    clean.requestTiming = emptyRequestTiming();
    for (const key of Object.keys(clean.requestTiming) as (keyof RequestTiming)[]) {
      if (validNumber(timing[key], !key.endsWith('Ms'))) clean.requestTiming[key] = timing[key];
      else clean.timingKnown = false;
    }
  }
  return clean;
}
/**
 * Sum two totals.
 *
 * The five boundary and decode fields are read defensively, because they are newer than the log that is
 * folded here: a session recorded by an older build carries statistics without them, and `undefined + 0`
 * would poison every later total with `NaN` instead of reading as "this run closed no step we counted".
 */
export function addStatistics(a: SessionStatistics, b: SessionStatistics): SessionStatistics {
  a = normalizeStatistics(a);
  b = normalizeStatistics(b);
  const requestTiming = a.requestTiming || b.requestTiming ? emptyRequestTiming() : undefined;
  if (requestTiming) {
    for (const key of Object.keys(requestTiming) as (keyof RequestTiming)[])
      requestTiming[key] = (a.requestTiming?.[key] ?? 0) + (b.requestTiming?.[key] ?? 0);
  }
  const total: SessionStatistics = {
    ...(requestTiming ? { requestTiming } : {}),
    turns: (a.turns ?? 0) + (b.turns ?? 0),
    steps: (a.steps ?? 0) + (b.steps ?? 0),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    cacheKnown: a.cacheKnown && b.cacheKnown,
    timingKnown: a.timingKnown && b.timingKnown,
    usageComplete: a.usageComplete !== false && b.usageComplete !== false,
    modelMs: a.modelMs + b.modelMs,
    toolMs: a.toolMs + b.toolMs,
    firstTokenMs: a.firstTokenMs + b.firstTokenMs,
    firstTokenCount: a.firstTokenCount + b.firstTokenCount,
    decodeMs: (a.decodeMs ?? 0) + (b.decodeMs ?? 0),
    decodeTokens: (a.decodeTokens ?? 0) + (b.decodeTokens ?? 0),
    ...(a.decodeKnown !== undefined || b.decodeKnown !== undefined
      ? {
          decodeKnown:
            (a.decodeMs > 0 ? a.decodeKnown === true : true) &&
            (b.decodeMs > 0 ? b.decodeKnown === true : true),
        }
      : {}),
  };
  for (const key of [...USAGE_FIELDS, ...TIMING_FIELDS, ...COUNT_FIELDS]) {
    if (total[key] <= Number.MAX_SAFE_INTEGER) continue;
    total[key] = Number.MAX_SAFE_INTEGER;
    if ((USAGE_FIELDS as readonly string[]).includes(key)) total.usageComplete = false;
    else total.timingKnown = false;
  }
  if (total.requestTiming)
    for (const key of Object.keys(total.requestTiming) as (keyof RequestTiming)[])
      if (total.requestTiming[key] > Number.MAX_SAFE_INTEGER) {
        total.requestTiming[key] = Number.MAX_SAFE_INTEGER;
        total.timingKnown = false;
      }
  return total;
}
