/**
 * The background jobs card list: which jobs belong to the session on screen, what the header entry says, and how
 * each row reads.
 *
 * The entry is offered only while the session has jobs, including completed ones; the popover is hover/focus
 * revealed. Nothing here formats DOM: it returns keys and readings, so the React panel and the tests share one
 * source for the words and the elapsed time.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { BackgroundJobSnapshot as BackgroundJob } from '../../../../packages/protocol/rpc.ts';
import { format, translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';

const RUNNING = new Set(['starting', 'running']);

export function isBackgroundRunning(job: BackgroundJob): boolean {
  return RUNNING.has(job.status);
}

/** `pwsh`, `bash`, `cmd`… when the command starts with one; otherwise `null` (the row prints "Command"). */
export function shellOf(command: string): string | null {
  const match = /^(pwsh|powershell|bash|zsh|cmd|sh)(?:\.exe)?(?=\s|$)/i.exec(command.trim());
  return match?.[1] ?? null;
}

export function backgroundStatusKey(status: string): string {
  return status === 'idle' ? 'background.title' : `background.${status}`;
}

export function backgroundOverall(jobs: readonly BackgroundJob[]): string {
  if (jobs.some(isBackgroundRunning)) return 'running';
  if (jobs.some((job) => job.status === 'failed')) return 'failed';
  if (jobs.some((job) => job.status === 'cancelled')) return 'cancelled';
  return jobs.length ? 'completed' : 'idle';
}

/** `1小时2分3秒` / `1h 2m 3s`; `—` when the timestamps are not parseable. */
export function backgroundElapsed(
  createdAt: string,
  finishedAt: string | undefined,
  now: number,
  lang: UiLanguage,
): string {
  const start = Date.parse(createdAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const total = Math.floor(Math.max(0, end - start) / 1_000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const values = { hours, minutes, seconds };
  if (hours > 0) return translate('background.durationHours', lang, values);
  if (minutes > 0) return translate('background.durationMinutes', lang, values);
  return translate('background.durationSeconds', lang, values);
}

export interface BackgroundRow {
  id: string;
  sessionId: string;
  command: string;
  shell: string | null;
  status: string;
  statusLabelKey: string;
  /** `completed` / `cancelled` / … styling token on the status cell. */
  statusClass: string;
  /** `ongoing` / `done` / `idle` token on the dot. */
  indicator: string;
  exitLabel: string | null;
  duration: string;
  stoppable: boolean;
}

export interface BackgroundView {
  visible: boolean;
  overall: string;
  statusLabelKey: string;
  label: string;
  ariaLabel: string;
  rows: BackgroundRow[];
}

export function backgroundView(
  snapshot: CarrierSnapshot | null,
  lang: UiLanguage,
  now = Date.now(),
): BackgroundView {
  const jobs =
    snapshot?.background.filter((job) => job.sessionId === snapshot.session.sessionId) ?? [];
  const running = jobs.filter(isBackgroundRunning).length;
  const overall = backgroundOverall(jobs);
  const statusLabel = translate(backgroundStatusKey(overall), lang);
  const label = !jobs.length
    ? translate('background.title', lang)
    : format(translate(running ? 'background.runningCount' : 'background.totalCount', lang), {
        count: running || jobs.length,
      });
  return {
    visible: jobs.length > 0,
    overall,
    statusLabelKey: backgroundStatusKey(overall),
    label,
    ariaLabel: `${label} · ${statusLabel}`,
    rows: jobs.map((job) => {
      const finished = !isBackgroundRunning(job);
      const statusLabelKey = backgroundStatusKey(job.status);
      return {
        id: job.id,
        sessionId: job.sessionId,
        command: job.command,
        shell: shellOf(job.command),
        status: job.status,
        statusLabelKey,
        statusClass: job.status,
        indicator: !finished ? 'ongoing' : job.status === 'completed' ? 'done' : 'idle',
        exitLabel:
          job.status !== 'cancelled' && job.exitCode !== null
            ? format(translate('background.exitCodeValue', lang), { code: job.exitCode })
            : null,
        duration:
          !finished || job.finishedAt
            ? backgroundElapsed(job.createdAt, job.finishedAt, now, lang)
            : '—',
        stoppable: !finished,
      };
    }),
  };
}
