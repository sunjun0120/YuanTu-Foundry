import type { Usage } from './index.ts';
/**
 * What a session has spent and how long it took, defined the same way as DSH's session panel so the
 * two agree:
 *
 * - `modelMs` is the step's wall time (start to assembled answer), retries included; a step with no
 *   answer contributes nothing.
 * - `firstTokenMs` runs from step start to first visible text.
 * - `decodeMs` starts at visible body text; `decodeTokens` excludes reasoning and counts only
 *   text-only answers with a known usage split. Throughput needs `decodeKnown`.
 * - `toolMs` pairs a call with its result, approval waits included.
 * - `turns`/`steps` count closed boundaries, so counts match a reloaded log.
 *
 * `cacheKnown`, `timingKnown` and `usageComplete` record whether the provider ever omitted part of
 * a total.
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
/**
 * What a token budget counts: output plus uncached input. Cached reads are excluded so budgets
 * track new work, not rounds x context. With no cache figure, all input counts.
 */
export function billableTokens(usage: Usage): number {
  const cached = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens));
  return usage.inputTokens - cached + usage.outputTokens;
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
 * Sum two totals. Newer fields are read defensively because older logs lack them and `undefined`
 * would turn every total into `NaN`.
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
