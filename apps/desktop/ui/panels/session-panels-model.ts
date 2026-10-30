/**
 * The three session-status panels — checklist, goal, presented files — as readings.
 *
 * Each is a pure function of the latest snapshot and is hidden rather than emptied when there is nothing to show: an
 * empty panel reads as "the plan is empty" rather than "there is no plan".
 *
 * The checklist belongs to the question being answered, not to the session: a list written while answering one question
 * says nothing about the next, so it is shown only while the newest `todo_write` is newer than the newest user message.
 * That falls out of the transcript, which is why it also holds after a reload.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { TodoItem } from '../../../../packages/protocol/index.ts';
import type { Goal } from '../../../../packages/protocol/goals.ts';
import type { PresentedFile } from '../../../../packages/protocol/deliverables.ts';
import { isRuntimeContext } from '../../../../packages/protocol/context.ts';
import { format, translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';

export interface TodosView {
  visible: boolean;
  total: number;
  counts: { pending: number; in_progress: number; completed: number };
  summary: string;
  countText: string;
  rows: { mark: string; content: string; className: string }[];
}

export function todosView(
  snapshot: CarrierSnapshot | null,
  todos: TodoItem[],
  lang: UiLanguage,
): TodosView {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  const messages = snapshot?.session.messages ?? [];
  const newestUser = messages.findLastIndex(
    (message) => message.role === 'user' && !isRuntimeContext(message.content),
  );
  const newestPlan = messages.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      (message.toolCalls ?? []).some((call) => call.name === 'todo_write'),
  );
  return {
    visible: todos.length > 0 && newestPlan > newestUser,
    total: todos.length,
    counts,
    summary: format(translate('ui.todosSummary', lang), {
      completed: counts.completed,
      inProgress: counts.in_progress,
      pending: counts.pending,
    }),
    countText: format(translate('ui.todosCount', lang), {
      total: todos.length,
      completed: counts.completed,
      inProgress: counts.in_progress,
      pending: counts.pending,
    }),
    rows: todos.map((todo) => ({
      mark: todo.status === 'completed' ? '✓' : '◌',
      content: todo.content,
      className: `todo todo-${todo.status.replace('_', '-')}`,
    })),
  };
}

export interface GoalView {
  visible: boolean;
  statusText: string;
  statusClass: string;
  objective: string;
  meta: string;
}

export function goalView(goal: Goal | null, lang: UiLanguage): GoalView {
  if (!goal) return { visible: false, statusText: '', statusClass: '', objective: '', meta: '' };
  const parts = [
    format(translate('ui.goalRounds', lang), {
      spent: Math.min(goal.roundsStarted, goal.maxGoalRounds),
      max: goal.maxGoalRounds,
    }),
    goal.blockedReason
      ? format(translate('ui.goalBlockedReason', lang), { reason: goal.blockedReason })
      : '',
    goal.status === 'active' && goal.standDown
      ? format(translate(`ui.goalStandDown.${goal.standDown.reason}`, lang), {
          rounds: goal.standDown.continuations,
        })
      : translate('ui.goalNotice', lang),
  ].filter(Boolean);
  return {
    visible: true,
    statusText: translate(`ui.goalStatus.${goal.status}`, lang),
    statusClass: `goal-status goal-${goal.status}`,
    objective: goal.objective,
    meta: parts.join(' · '),
  };
}

export interface DeliverableRow {
  path: string;
  label: string;
  kind: 'html' | 'document';
  format: string;
  description: string;
  title: string;
}

export function deliverablesView(files: PresentedFile[]): {
  visible: boolean;
  rows: DeliverableRow[];
} {
  return {
    visible: files.length > 0,
    rows: files.map((file) => {
      const name = file.path.split(/[\\/]/u).pop() || file.path;
      const extension = name.match(/\.([a-z0-9]{1,10})$/iu)?.[1]?.toUpperCase() ?? 'FILE';
      const html = extension === 'HTML' || extension === 'HTM';
      return {
        path: file.path,
        label: file.description?.trim() || name,
        kind: html ? 'html' : 'document',
        format: html ? 'HTML' : extension,
        description: file.description ?? '',
        title: `${file.bytes} B · sha256 ${file.sha256.slice(0, 12)}… · ${file.at}`,
      };
    }),
  };
}
