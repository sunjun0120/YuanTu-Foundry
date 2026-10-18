import type { Acceptance, Task } from '../../packages/protocol/index.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { locale } from './i18n.ts';
import {
  el,
  evidence,
  statusLabel,
  stepJournal,
  tr,
  triggerSummary,
} from './renderer-tasks-format.ts';
import { scheduleEditor, taskEditor, type EditorHost } from './renderer-tasks-editors.ts';
/**
 * What a person has ticked but not yet confirmed.
 *
 * The ticks are a draft, not display state: they used to be a `Set` created inside one pass of the card loop,
 * so any rebuild of the list — a new step checkpoint, a new attempt, a language switch — silently cleared them
 * and left the confirm button looking clickable while it did nothing. They are kept here instead, keyed by
 * session and task, and reused only while the run and the acceptance definition are the same: an index into a
 * different list of criteria means something else, so a different run or a redefined criterion starts empty.
 */
interface ConfirmDraft {
  runId: string;
  definitionKey: string;
  indices: Set<number>;
}
/**
 * The identity of an acceptance list, excluding `met`.
 *
 * `met` is deliberately absent: confirming is what flips it, and a definition that changed identity the moment
 * it was confirmed would throw away the very draft the confirmation is reporting on.
 */
export function acceptanceDefinitionKey(acceptance: readonly Acceptance[]): string {
  return JSON.stringify(
    acceptance.map((item) => {
      const check = item.check;
      return check
        ? [
            item.description,
            check.kind,
            check.path ?? null,
            check.expected ?? null,
            check.command ?? null,
            check.args ?? null,
            check.cwd ?? null,
            check.expectation ?? null,
          ]
        : [item.description, null];
    }),
  );
}
export class TaskConfirmDrafts {
  private readonly drafts = new Map<string, ConfirmDraft>();
  private static key(sessionKey: string, taskId: string): string {
    return `${sessionKey}\u0000${taskId}`;
  }
  /** The live selection for this task, reset whenever the run or the definition it indexes has changed. */
  selection(sessionKey: string, task: Task): Set<number> {
    const key = TaskConfirmDrafts.key(sessionKey, task.id);
    const runId = task.latestRunId ?? '';
    const definitionKey = acceptanceDefinitionKey(task.acceptance);
    const existing = this.drafts.get(key);
    if (!existing || existing.runId !== runId || existing.definitionKey !== definitionKey) {
      const fresh: ConfirmDraft = { runId, definitionKey, indices: new Set() };
      this.drafts.set(key, fresh);
      return fresh.indices;
    }
    // A criterion that is now met, or gone, cannot be confirmed again; the index would point elsewhere.
    for (const index of [...existing.indices])
      if (index >= task.acceptance.length || task.acceptance[index]!.met)
        existing.indices.delete(index);
    return existing.indices;
  }
  /** Keep only this session's live tasks: another session's ticks, or a deleted task's, are not a draft. */
  retain(sessionKey: string, taskIds: Iterable<string>): void {
    const prefix = `${sessionKey}\u0000`;
    const live = new Set(taskIds);
    for (const key of [...this.drafts.keys()])
      if (!key.startsWith(prefix) || !live.has(key.slice(prefix.length))) this.drafts.delete(key);
  }
}
export function setupTasks(send: (command: CarrierCommand) => Promise<CarrierSnapshot | null>) {
  const list = document.getElementById('task-list')!;
  let snapshot: CarrierSnapshot | null = null,
    busy = false,
    key = '',
    session = '';
  let edit: { task: Task; form: HTMLFormElement; revision: string } | undefined;
  let schedule: { taskId: string; form: HTMLFormElement; revision: string } | undefined;
  // The unconfirmed ticks belong to the session and task, not to the frame that drew them.
  const drafts = new TaskConfirmDrafts();
  const button = (parent: HTMLElement, label: string, action: () => void, disabled = false) => {
    const b = el('button', label, 'secondary');
    b.type = 'button';
    b.disabled = busy || disabled;
    b.addEventListener('click', action);
    parent.append(b);
    return b;
  };
  const host = (
    current: () => { revision: string } | undefined,
    forget: () => void,
  ): EditorHost => ({
    send,
    button,
    snapshot: () => snapshot,
    busy: () => busy,
    current,
    close: (next, locked) => {
      forget();
      key = '';
      render(next, locked);
    },
  });
  function editor(task: Task) {
    const { form, draft } = taskEditor(
      task,
      host(
        () => edit,
        () => (edit = undefined),
      ),
    );
    edit = { task: draft, form, revision: task.updatedAt };
    return form;
  }
  function openSchedule(task: Task) {
    const form = scheduleEditor(
      task,
      host(
        () => schedule,
        () => (schedule = undefined),
      ),
    );
    schedule = { taskId: task.id, form, revision: task.updatedAt };
    return form;
  }
  function render(next: CarrierSnapshot | null, locked: boolean) {
    snapshot = next;
    busy = locked || !!next?.session.running || !!next?.session.loading;
    const nextSession = `${next?.workspace}:${next?.session.sessionId}`;
    if (session !== nextSession) {
      edit = undefined;
      schedule = undefined;
      session = nextSession;
      key = '';
    }
    // Drafts follow the live session's tasks: a switched session or a deleted task leaves nothing behind.
    drafts.retain(
      session,
      (next?.tasks ?? []).map((task) => task.id),
    );
    document.getElementById('tasks-panel')!.hidden = !next?.tasks.length;
    const newKey = JSON.stringify([next?.tasks, next?.taskAttempts, next?.taskSteps, locale()]);
    if (edit || schedule) {
      const target = edit?.task.id ?? schedule!.taskId;
      const current = next?.tasks.find((t) => t.id === target);
      const stale = current?.updatedAt !== (edit?.revision ?? schedule!.revision);
      const form = edit?.form ?? schedule!.form;
      form.querySelector('fieldset')!.disabled = busy;
      const save = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      save.disabled = busy || stale;
      if (stale)
        form.querySelector('.task-edit-warning')!.textContent = tr(
          '任务已更新；请取消后重新编辑。当前输入仍保留。',
          'Task changed. Cancel and reopen to edit the latest version. Your input is preserved.',
        );
      return;
    }
    if (key === newKey) {
      list
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => (b.disabled = busy || b.dataset.unavailable === 'true'));
      list
        .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
        .forEach((input) => (input.disabled = busy));
      return;
    }
    key = newKey;
    list.replaceChildren();
    for (const task of next?.tasks ?? []) {
      const card = el('article', '', 'task-card');
      card.dataset.taskId = task.id;
      const header = el('div', '', 'task-card-header');
      header.append(
        el('h3', task.title),
        el('span', statusLabel(task.status), `task-status ${task.status}`),
      );
      card.append(header, el('p', task.description, 'task-description'));
      const timeline = el('p', '', 'task-schedule-summary');
      timeline.textContent =
        triggerSummary(task) +
        (task.nextRunAt
          ? ` · ${tr('下次', 'Next')} ${new Date(task.nextRunAt).toLocaleString()}`
          : '') +
        (task.lastRunAt
          ? ` · ${tr('上次', 'Last')} ${new Date(task.lastRunAt).toLocaleString()}`
          : '');
      card.append(timeline);
      /**
       * Why this one is late, when it is.
       *
       * The host writes down a scheduled moment it was too busy to start, and this is the only place a person can
       * see it: without the line, a task that fired while another run was in flight looks like a task that simply
       * ran late. The reason is shown as the host recorded it (`busy` / `closed`) rather than reinterpreted here.
       */
      if (task.waiting)
        card.append(
          el(
            'p',
            `${tr('等待中', 'Waiting')} · ${task.waiting.reason} · ${new Date(task.waiting.since).toLocaleString()}`,
            'task-waiting',
          ),
        );
      if (task.lastTriggerError) card.append(el('p', task.lastTriggerError, 'task-schedule-error'));
      if (task.pendingApproval) {
        const review = el('section', '', 'task-approval');
        const pending = task.pendingApproval;
        review.append(
          el(
            'strong',
            pending.state === 'pending'
              ? tr('等待操作审批', 'Awaiting operation approval')
              : pending.state === 'approved'
                ? tr('已批准，等待续跑', 'Approved; waiting to resume')
                : tr('已拒绝，自动触发已暂停', 'Rejected; automatic trigger paused'),
          ),
        );
        review.append(el('p', `${pending.kind} · ${pending.tool}`));
        review.append(el('pre', pending.description));
        if (pending.state === 'pending') {
          const actions = el('div', '', 'task-actions');
          button(
            actions,
            tr('拒绝并暂停', 'Reject and pause'),
            () =>
              void send({
                type: 'taskApproval',
                taskId: task.id,
                approvalId: pending.id,
                allow: false,
              }),
          );
          button(
            actions,
            tr('批准并续跑', 'Approve and resume'),
            () =>
              void send({
                type: 'taskApproval',
                taskId: task.id,
                approvalId: pending.id,
                allow: true,
              }),
          );
          review.append(actions);
        }
        card.append(review);
      }
      const steps = el('ol', '', 'task-steps');
      task.steps.forEach((step) => steps.append(el('li', `${step.status} · ${step.description}`)));
      card.append(steps);
      const indices = drafts.selection(session, task);
      const manual = task.acceptance.some((a) => !a.check);
      const canConfirm =
        !!task.latestRunId &&
        !!task.verification &&
        !['pending', 'in_progress'].includes(task.status);
      // Declared before the rows so each row's listener can update the one button below them.
      let confirm: HTMLButtonElement | undefined;
      task.acceptance.forEach((item, index) => {
        const row = el('label', '', 'task-acceptance-row');
        if (!item.check && canConfirm && !item.met) {
          const input = el('input');
          input.type = 'checkbox';
          input.disabled = busy;
          input.checked = indices.has(index);
          input.addEventListener('change', () => {
            input.checked ? indices.add(index) : indices.delete(index);
            const empty = indices.size === 0;
            if (confirm) {
              confirm.disabled = busy || empty;
              confirm.dataset.unavailable = String(empty);
            }
          });
          row.append(input);
        }
        row.append(
          el(
            'span',
            `${item.met ? '✓' : '○'} ${item.description} · ${item.check?.kind ?? tr('人工确认', 'Manual')}`,
          ),
        );
        card.append(row);
      });
      evidence(card, task.verification);
      const actions = el('div', '', 'task-actions');
      card.append(actions);
      const action = (zh: string, en: string, command: CarrierCommand, unavailable = false) => {
        const b = button(actions, tr(zh, en), () => void send(command), unavailable);
        b.dataset.unavailable = String(unavailable);
      };
      button(actions, tr('编辑', 'Edit'), () => {
        list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        card.replaceChildren(header, editor(task));
      });
      button(actions, tr('触发设置', 'Trigger settings'), () => {
        list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        card.replaceChildren(header, openSchedule(task));
      });
      if (!task.latestRunId)
        action('开始执行', 'Start execution', { type: 'taskStart', taskId: task.id });
      else action('重试', 'Retry', { type: 'taskRetry', taskId: task.id });
      action('重新制定计划', 'Regenerate plan', { type: 'taskPropose', taskId: task.id });
      action('验收', 'Verify', { type: 'taskVerify', taskId: task.id }, !task.latestRunId);
      if (manual && canConfirm) {
        const empty = indices.size === 0;
        confirm = button(
          actions,
          tr('确认勾选的人工结果', 'Confirm selected manual results'),
          () => {
            if (!indices.size) return;
            void send({
              type: 'taskConfirm',
              taskId: task.id,
              indices: [...indices],
              expectedUpdatedAt: task.updatedAt,
            }).then((result) => {
              // A stale `updatedAt` is refused by the Host's own gate; re-reading is the answer either way.
              if (result) render(result, false);
            });
          },
          empty,
        );
        confirm.dataset.unavailable = String(empty);
      }
      action('历史', 'History', { type: 'taskHistory', taskId: task.id });
      stepJournal(card, next?.taskSteps[task.id] ?? []);
      const attempts = next?.taskAttempts[task.id] ?? [];
      if (attempts.length) {
        const history = el('details', '', 'task-history');
        history.append(el('summary', tr('历史尝试', 'Attempt history') + ` (${attempts.length})`));
        for (const attempt of attempts) {
          history.append(
            el(
              'p',
              `${attempt.kind} · ${attempt.status} · ${attempt.startedAt}` +
                `${attempt.trigger && attempt.trigger !== 'manual' ? ` · ${attempt.trigger}` : ''}` +
                `${attempt.resume ? ` · ${tr('续跑', 'resumed')}` : ''}` +
                `${attempt.error ? ` · ${attempt.error}` : ''}`,
            ),
          );
          evidence(history, attempt.verification);
        }
        card.append(history);
      }
      list.append(card);
    }
  }
  return render;
}
