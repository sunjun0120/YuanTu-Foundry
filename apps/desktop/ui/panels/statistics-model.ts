/**
 * What the two readings under the composer say, without the DOM.
 *
 * Every figure is optional: a session with no step and no token has no reading at all, so neither pill is shown;
 * a session with steps but no timed figure keeps its counts as plain text instead of a button over an empty dialog.
 * A measurement the product does not have is not a reading — `throughputReading` returns `null` rather than a row
 * saying it knows nothing, and a row whose value is empty is left out of its panel entirely.
 *
 * Nothing here aggregates: the sums live in `packages/protocol/statistics.ts` and the run that fills them in.
 */
import type {
  SessionSnapshot,
  StatisticsDelta,
} from '../../../../packages/client/session-controller.ts';
import type { SessionStatistics } from '../../../../packages/protocol/statistics.ts';
import { translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import { formatExactTokens, formatTokens } from '../../token-format.ts';

/** Below a second of decoding or fifty tokens the rate is arithmetic, not a measurement. */
const MIN_DECODE_MS = 1_000;
const MIN_DECODE_TOKENS = 50;
/** A request this large is paid again on every later turn; past it the pill suggests a new session. */
const LONG_CONTEXT_TOKENS = 400_000;

export function billedInputTokens(stats: SessionStatistics): number {
  return stats.inputTokens;
}

export function throughputReading(stats: SessionStatistics): string | null {
  if (!(stats.decodeMs > 0) || stats.decodeKnown !== true) return null;
  if (stats.decodeMs < MIN_DECODE_MS || stats.decodeTokens < MIN_DECODE_TOKENS) return null;
  const tps = stats.decodeTokens / (stats.decodeMs / 1_000);
  return (tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)) + ' tok/s';
}

/**
 * Cache-hit share of the prompt, DSH's rounding rule included: a partial hit never displays as a full one.
 *
 * `missed <= 0` also guards the widening loop: the fields are validated one at a time, so a cache-read bucket can
 * exceed the billed input, and a negative gap would otherwise make the loop run forever on the paint path.
 */
export function cacheHitPercent(stats: SessionStatistics): string | null {
  const promptTokens = billedInputTokens(stats);
  if (promptTokens === 0) return null;
  const cacheReadTokens = stats.cachedInputTokens;
  const missed = promptTokens - cacheReadTokens;
  if (missed <= 0) return '100';
  const rounded = Math.round((cacheReadTokens / promptTokens) * 100);
  if (rounded < 100) return String(rounded);
  let places = 1;
  let gap = missed * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (gap <= denominatorTens) {
    gap *= 10;
    places += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let loss = 5;
  for (let candidate = 1; candidate < 5; candidate += 1) {
    const factor = candidate * 2 + 1;
    if (gap <= factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)) {
      loss = candidate;
      break;
    }
  }
  return `99.${'9'.repeat(places - 1)}${10 - loss}`;
}

/** Both cache buckets are parts of the billed input, so both come out; clamped because each field is valid alone. */
export function uncachedInputTokens(stats: SessionStatistics): number {
  return Math.max(0, stats.inputTokens - stats.cachedInputTokens - stats.cacheWriteInputTokens);
}

/** `4.2秒` / `4.2s`; `102分35秒` / `102m35s` — no spaces around the units. */
export function durationReading(ms: number, lang: UiLanguage): string {
  const seconds = ms / 1_000;
  if (seconds < 60)
    return translate('statistics.seconds', lang, { value: Math.round(seconds * 10) / 10 });
  const whole = Math.round(seconds);
  return translate('statistics.minutes', lang, {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  });
}

export function countsReading(
  stats: SessionStatistics,
  lang: UiLanguage,
  tps: string | null,
): string {
  const counts = translate('statistics.counts', lang, { turns: stats.turns, steps: stats.steps });
  return tps === null ? counts : `${counts} · ${tps}`;
}

/** The usage pill: this run first when it is smaller, then the cumulative session figure and its caveats. */
export function usagePillReading(
  input: { total: number; cacheHit: string | null; runTotal: number; contextTokens: number },
  lang: UiLanguage,
): string {
  const parts: string[] = [];
  if (input.runTotal > 0 && input.runTotal < input.total)
    parts.push(translate('statistics.runTotal', lang, { total: formatTokens(input.runTotal) }));
  parts.push(translate('statistics.sessionTotal', lang, { total: formatTokens(input.total) }));
  if (input.cacheHit !== null)
    parts.push(translate('statistics.cacheHitPill', lang, { percent: input.cacheHit }));
  if (input.contextTokens >= LONG_CONTEXT_TOKENS)
    parts.push(translate('statistics.longContext', lang));
  return parts.join(' · ');
}

export interface StatisticsRow {
  key: string;
  value: string;
}

export interface StatisticsPanel {
  titleKey: string;
  rows: StatisticsRow[];
  /** Only the usage panel has a headline figure; the time panel's total is its pill. */
  total: string | null;
}

export interface StatisticsView {
  session: StatisticsPanel | null;
  tokens: StatisticsPanel | null;
  counts: string;
  tps: string | null;
  usage: string;
  /** A pill exists while the session has steps, even when it has no timed figure to open a dialog with. */
  sessionVisible: boolean;
  sessionOpenable: boolean;
  tokensVisible: boolean;
  hidden: boolean;
}

export function statisticsView(
  snapshot: SessionSnapshot | undefined,
  lang: UiLanguage,
): StatisticsView {
  const stats = snapshot?.statistics ?? emptyCounts();
  const total = billedInputTokens(stats) + stats.outputTokens;
  const cacheHit = cacheHitPercent(stats);
  const tps = throughputReading(stats);
  const counts = countsReading(stats, lang, tps);
  const usage = usagePillReading(
    {
      total,
      cacheHit,
      runTotal: snapshot?.runStatistics
        ? billedInputTokens(snapshot.runStatistics) + snapshot.runStatistics.outputTokens
        : 0,
      contextTokens: snapshot?.budget?.inputTokens ?? 0,
    },
    lang,
  );
  const timed =
    stats.modelMs > 0 || stats.toolMs > 0 || stats.firstTokenCount > 0 || stats.decodeMs > 0;
  const session =
    stats.steps > 0 && timed
      ? {
          titleKey: 'statistics.sessionTitle',
          total: null,
          rows: [
            stats.modelMs > 0
              ? { key: 'statistics.modelTime', value: durationReading(stats.modelMs, lang) }
              : null,
            stats.toolMs > 0
              ? { key: 'statistics.toolsApprovals', value: durationReading(stats.toolMs, lang) }
              : null,
            stats.firstTokenCount > 0
              ? {
                  key: 'statistics.ttft',
                  value: durationReading(stats.firstTokenMs / stats.firstTokenCount, lang),
                }
              : null,
            stats.decodeMs > 0 && tps !== null ? { key: 'statistics.tps', value: tps } : null,
          ].filter((row): row is StatisticsRow => row !== null),
        }
      : null;
  const tokens =
    total === 0
      ? null
      : {
          titleKey: 'statistics.tokensTitle',
          total: formatExactTokens(total),
          rows: [
            cacheHit === null ? null : { key: 'statistics.cacheHit', value: cacheHit + '%' },
            {
              key: 'statistics.uncachedInput',
              value: formatExactTokens(uncachedInputTokens(stats)),
            },
            { key: 'statistics.cachedInput', value: formatExactTokens(stats.cachedInputTokens) },
            stats.cacheWriteInputTokens !== 0
              ? {
                  key: 'statistics.cacheWrite',
                  value: formatExactTokens(stats.cacheWriteInputTokens),
                }
              : null,
            { key: 'statistics.output', value: formatExactTokens(stats.outputTokens) },
          ].filter((row): row is StatisticsRow => row !== null),
        };
  return {
    session,
    tokens,
    counts,
    tps,
    usage,
    sessionVisible: stats.steps > 0,
    sessionOpenable: session !== null,
    tokensVisible: tokens !== null,
    hidden: stats.steps === 0 && tokens === null,
  };
}

function emptyCounts(): SessionStatistics {
  return {
    turns: 0,
    steps: 0,
    modelMs: 0,
    toolMs: 0,
    firstTokenMs: 0,
    firstTokenCount: 0,
    decodeMs: 0,
    decodeTokens: 0,
    decodeKnown: false,
    cacheKnown: false,
    timingKnown: false,
    usageComplete: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  };
}

/**
 * A statistics delta patches the session it names and nothing else: a delta for a session that was switched away
 * from while it was in flight belongs to a reading nobody is looking at.
 */
export function applyStatisticsDelta(
  snapshot: SessionSnapshot | null | undefined,
  delta: StatisticsDelta,
): SessionSnapshot | null {
  if (!snapshot || snapshot.sessionId !== delta.sessionId) return null;
  return {
    ...snapshot,
    statistics: delta.statistics,
    ...(delta.runStatistics !== undefined ? { runStatistics: delta.runStatistics } : {}),
    statisticsActivity: delta.activity,
  };
}
