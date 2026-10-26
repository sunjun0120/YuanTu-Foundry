/**
 * The sub-agent readings both surfaces share: a status, a work time, what a child has spent, and the findings it
 * reported with the evidence it gave.
 *
 * The numbers come from the child's own session and arrive on the delta channel, but the shapes are here so the catalog
 * and the detail panel cannot disagree: one pair of functions formats both.
 */
import type { SubAgentSummaryReport } from '../../../../packages/protocol/index.ts';
import type { SubAgentView } from '../../../../packages/client/session-controller.ts';
import { translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import { formatTokens } from '../../token-format.ts';

export function subagentRunning(view: SubAgentView): boolean {
  return view.runningSince !== undefined && view.runningSince !== null;
}

export function subagentStatusLabel(view: SubAgentView, lang: UiLanguage): string {
  const key = `subagent.status.${view.status}`;
  const text = translate(key, lang);
  // A missing key renders as the raw key; an unknown Host status falls back to the status string instead.
  return text === key ? view.status : text;
}

/**
 * A child's work time: the turns it has finished, plus the one it is in the middle of. A child that is not running is
 * frozen at exactly what its log says it spent, so a reload and a live window show the same number.
 */
export function subagentWorkMs(view: SubAgentView, now: number): number {
  const settled = view.durationMs ?? 0;
  return subagentRunning(view)
    ? settled + Math.max(0, now - (view.runningSince as number))
    : settled;
}

/** Seconds, then minutes with two-digit seconds, then hours, then days; no months or years. */
export function subagentWorkDuration(view: SubAgentView, now: number, lang: UiLanguage): string {
  const totalSeconds = Math.floor(subagentWorkMs(view, now) / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const days = Math.floor(totalSeconds / 86_400);
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (days > 0)
    return hours === 0
      ? translate('subagent.duration.days', lang, { days })
      : translate('subagent.duration.daysHours', lang, { days, hours });
  if (totalSeconds >= 3_600)
    return translate('subagent.duration.hours', lang, {
      hours,
      minutes: pad(minutes),
      seconds: pad(seconds),
    });
  if (totalSeconds >= 60)
    return translate('subagent.duration.minutes', lang, { minutes, seconds: pad(seconds) });
  return translate('subagent.duration.seconds', lang, { seconds });
}

/** `undefined` when the child has reported nothing: `inputTokens` already includes the cache buckets. */
export function subagentTokenTotal(view: SubAgentView): number | undefined {
  return view.usage ? view.usage.inputTokens + view.usage.outputTokens : undefined;
}

export function subagentTokenText(view: SubAgentView, lang: UiLanguage): string {
  const total = subagentTokenTotal(view);
  return total === undefined
    ? ''
    : translate('subagent.tokens', lang, { value: formatTokens(total) });
}

/** Which of DSH's three dots a child gets: working, finished cleanly, or anything else. */
export function subagentDotState(view: SubAgentView): 'ongoing' | 'done' | 'idle' {
  if (view.status === 'running') return 'ongoing';
  return view.status === 'completed' ? 'done' : 'idle';
}

export interface FindingsReading {
  summary: string;
  heading: string;
  findings: { statement: string; evidence: string }[];
  unverified: string | null;
  blockers: string | null;
}

export function subagentFindings(report: SubAgentSummaryReport, lang: UiLanguage): FindingsReading {
  return {
    summary: report.summary,
    heading: translate('subagent.findings', lang),
    findings: report.findings.map((finding) => ({
      statement: finding.statement,
      evidence:
        `${translate('subagent.evidence', lang)}: ${finding.evidence}` +
        (finding.paths?.length ? ` [${finding.paths.join(', ')}]` : ''),
    })),
    unverified: report.unverified?.length
      ? `${translate('subagent.unverified', lang)}: ${report.unverified.join('; ')}`
      : null,
    blockers: report.blockers?.length
      ? `${translate('subagent.blockers', lang)}: ${report.blockers.join('; ')}`
      : null,
  };
}
