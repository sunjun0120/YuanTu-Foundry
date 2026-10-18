import type {
  AcceptanceEvidence,
  Task,
  TaskEventName,
  TaskStepCheckpoint,
} from '../../packages/protocol/index.ts';
import { locale } from './i18n.ts';

/** The task panel's small pieces: labels, the trigger summary and the read-only evidence blocks. */
export const tr = (zh: string, en: string) => (locale() === 'zh-CN' ? zh : en);
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = cls;
  return result;
}
export function statusLabel(status: string): string {
  const labels: Record<string, [string, string]> = {
    pending: ['\u5f85\u786e\u8ba4\u8349\u7a3f', 'Draft'],
    in_progress: ['\u6267\u884c\u4e2d', 'In progress'],
    completed: ['\u5df2\u5b8c\u6210', 'Completed'],
    needs_review: ['\u5f85\u9a8c\u6536', 'Needs review'],
    blocked: ['\u53d7\u963b', 'Blocked'],
    cancelled: ['\u5df2\u53d6\u6d88', 'Cancelled'],
    skipped: ['\u5df2\u8df3\u8fc7', 'Skipped'],
  };
  const label = labels[status];
  return label ? tr(...label) : status;
}
export function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
export function eventLabel(on: TaskEventName): string {
  const labels: Record<TaskEventName, [string, string]> = {
    'run.finished': ['任一任务执行结束', 'Any run finishes'],
    'task.completed': ['任务通过验收', 'A task passes verification'],
    'session.created': ['新建会话', 'A session is created'],
  };
  return tr(...labels[on]);
}
export function triggerSummary(task: Task): string {
  const trigger = task.trigger;
  if (!trigger) return tr('无自动触发', 'No automatic trigger');
  const paused =
    (trigger.enabled ? '' : ` · ${tr('已暂停', 'paused')}`) +
    ('misfire' in trigger && trigger.misfire
      ? ` · ${trigger.misfire === 'skip' ? tr('漏跑跳过', 'skip missed') : tr('漏跑合并最新', 'latest missed')}`
      : '');
  if (trigger.kind === 'interval')
    return tr(`每 ${trigger.everyMinutes} 分钟`, `Every ${trigger.everyMinutes} min`) + paused;
  if (trigger.kind === 'daily')
    return (
      tr(`每天 ${clock(trigger.atMinutes)}`, `Daily at ${clock(trigger.atMinutes)}`) +
      ` (${trigger.timeZone ?? tr('本机时区', 'local time')})` +
      paused
    );
  if (trigger.kind === 'weekly')
    return (
      tr(
        `每周 ${trigger.weekdays.join(',')} ${clock(trigger.atMinutes)}`,
        `Weekly ${trigger.weekdays.join(',')} at ${clock(trigger.atMinutes)}`,
      ) +
      ` (${trigger.timeZone})` +
      paused
    );
  if (trigger.kind === 'cron') return `Cron ${trigger.expression} (${trigger.timeZone})` + paused;
  if (trigger.kind === 'at') return tr('仅一次：', 'Once: ') + trigger.at + paused;
  if (trigger.kind === 'after')
    return (
      tr(
        `保存后 ${trigger.afterMinutes} 分钟，仅一次`,
        `Once, ${trigger.afterMinutes} minutes after saving`,
      ) + paused
    );
  return eventLabel(trigger.on) + paused;
}
export function evidence(parent: HTMLElement, value?: AcceptanceEvidence) {
  if (!value) return;
  const details = el('details', '', 'task-evidence');
  details.append(
    el(
      'summary',
      tr('验收证据', 'Verification evidence') +
        ` · ${value.passed ? tr('通过', 'Passed') : tr('未通过', 'Not passed')}`,
    ),
  );
  for (const check of value.checks) {
    details.append(
      el('strong', `${check.passed ? '✓' : '×'} ${check.id} · ${check.kind}`),
      el('pre', check.detail),
    );
    if (check.command)
      details.append(
        el(
          'pre',
          `exit: ${check.command.exitCode} · timeout: ${check.command.timedOut}\n${check.command.stdout}\n${check.command.stderr}`,
        ),
      );
  }
  parent.append(details);
}
/** The durable step journal: what actually survived, independent of the current step list. */
export function stepJournal(parent: HTMLElement, steps: TaskStepCheckpoint[]) {
  if (!steps.length) return;
  const details = el('details', '', 'task-step-journal');
  details.append(el('summary', tr('步骤检查点', 'Step checkpoints') + ` (${steps.length})`));
  for (const step of steps)
    details.append(
      el(
        'p',
        `${step.index} · ${step.status} · ${step.createdAt}${step.note ? ` · ${step.note}` : ''}`,
      ),
    );
  parent.append(details);
}
