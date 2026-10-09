/**
 * The three session-status panels that hang off the transcript: the checklist, the goal banner and the
 * presented files.
 *
 * They are one module because they answer one question between them — "what is this session doing and what has
 * it produced" — and because they share the shape that makes them cheap: each is a pure function of the latest
 * snapshot, guarded by a key so a streaming run repaints none of them, and each is hidden rather than emptied
 * when there is nothing to show (an empty panel reads as "the plan is empty" rather than "there is no plan").
 *
 * The key carries the locale in all three: every label here is translated or locale-formatted, so a language
 * change has to rebuild them.
 */
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { TodoItem } from '../../packages/protocol/index.ts';
import type { Goal } from '../../packages/protocol/goals.ts';
import type { PresentedFile } from '../../packages/protocol/deliverables.ts';
import { isRuntimeContext } from '../../packages/protocol/context.ts';
import { format, locale, t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupSessionPanels(getState: () => CarrierSnapshot | null): {
  todos(todos: TodoItem[]): void;
  goal(goal: Goal | null): void;
  deliverables(files: PresentedFile[]): void;
} {
  let todoKey = '';
  let todoSessionId = '';
  let goalKey = '';
  let deliverablesKey = '';
  /**
   * The checklist panel.
   *
   * The model replaces the whole list on every `todo_write`, so the panel is a pure function of the latest
   * list and a keyed rebuild keeps a streaming run from thrashing the DOM. It is hidden rather than emptied
   * when there is no list: an empty panel would read as "the plan is empty" rather than "there is no plan".
   *
   * A saved list remains available after the turn ends and through later turns until the model replaces or
   * clears it. Switching sessions folds the panel, so each session starts from the requested collapsed state.
   *
   * One item may be in progress at a time by convention and the renderer does not enforce it — the list is the
   * model's statement of what it is doing, and rewriting it to look tidier would hide what it actually said.
   *
   * It shows the list as it stands, and *only* as it stands. A "since the previous version: 3 added" strip used to
   * sit above it, describing the last write instead of the current list; that is a diff, and a diff answers a
   * question nobody asked while the panel is open ("what is the plan now?"), in a place where the answer — the
   * list itself — is right below it. The CLI still prints that summary (`describeTodoChange`), where a scrollback
   * has no list to look at and the change is the only thing a reader can see.
   */
  function todos(todos: TodoItem[]): void {
    const sessionId = getState()?.session.sessionId ?? '';
    if (sessionId !== todoSessionId) {
      required<HTMLDetailsElement>('todos-panel').open = false;
      todoSessionId = sessionId;
    }
    /**
     * The list belongs to the question being answered, not to the session.
     *
     * A plan written while answering one question says nothing about the next one, so the panel shows a list only
     * while it is newer than the last thing the person asked: the position of the newest `todo_write` against the
     * newest user message, both read off the transcript. That is what makes "ask something new and the old list
     * goes away, until the model writes a new one" fall out of the data — and it holds after a reload, where a
     * timer or a baseline remembered in this process would have nothing to go on.
     */
    const messages = getState()?.session.messages ?? [];
    const newestUser = messages.findLastIndex(
      (message) => message.role === 'user' && !isRuntimeContext(message.content),
    );
    const newestPlan = messages.findLastIndex(
      (message) =>
        message.role === 'assistant' &&
        (message.toolCalls ?? []).some((call) => call.name === 'todo_write'),
    );
    const belongsToThisQuestion = newestPlan > newestUser;
    const nextKey = JSON.stringify([sessionId, todos, belongsToThisQuestion, locale()]);
    if (nextKey === todoKey) return;
    todoKey = nextKey;
    const panel = required('todos-panel');
    panel.hidden = todos.length === 0 || !belongsToThisQuestion;
    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const todo of todos) counts[todo.status]++;
    required('todos-title').textContent = t('ui.todosTitle');
    required('todos-summary').textContent = format(t('ui.todosSummary'), {
      completed: counts.completed,
      inProgress: counts.in_progress,
      pending: counts.pending,
    });
    required('todos').replaceChildren(
      ...todos.map((todo) => {
        const item = node('li', '', `todo todo-${todo.status.replace('_', '-')}`);
        item.append(
          node(
            'span',
            todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◌' : '◌',
            'todo-mark',
          ),
          node('span', todo.content, 'todo-content'),
        );
        return item;
      }),
      node(
        'li',
        format(t('ui.todosCount'), {
          total: todos.length,
          completed: counts.completed,
          inProgress: counts.in_progress,
          pending: counts.pending,
        }),
        'todo-count',
      ),
    );
  }
  /**
   * The session goal, when a run declared one.
   *
   * A goal is the one piece of session state that answers "what is all of this for", so it is rendered above the
   * checklist rather than inside it: the goal outlives the run, the checklist belongs to it. It is a banner and
   * not a control — pausing or completing a goal is a tool call the model makes, and a button here would be a
   * second way to change a thing this window does not own. The status is shown because it is the reason the next
   * turn may not continue: a blocked or completed goal is a statement, not a spinner.
   */
  function goal(goal: Goal | null): void {
    const nextKey = JSON.stringify([goal, locale()]);
    if (nextKey === goalKey) return;
    goalKey = nextKey;
    const panel = required('goal-panel');
    panel.hidden = goal === null;
    if (!goal) return;
    required('goal-title').textContent = t('ui.goalTitle');
    const status = required('goal-status');
    status.textContent = t(`ui.goalStatus.${goal.status}`);
    status.className = `goal-status goal-${goal.status}`;
    required('goal-objective').textContent = goal.objective;
    const meta = [
      format(t('ui.goalRounds'), {
        spent: Math.min(goal.roundsStarted, goal.maxGoalRounds),
        max: goal.maxGoalRounds,
      }),
      goal.blockedReason ? format(t('ui.goalBlockedReason'), { reason: goal.blockedReason }) : '',
      t('ui.goalNotice'),
    ].filter(Boolean);
    required('goal-meta').textContent = meta.join(' · ');
  }
  /**
   * The files a run marked as its deliverables.
   *
   * A presentation record: each line is what `present` named and the reason it gave. Absent entirely when nothing
   * has been presented, because an empty panel would read as "the run produced nothing" rather than "no run has
   * said what it produced yet".
   */
  function deliverables(files: PresentedFile[]): void {
    const nextKey = JSON.stringify([files, locale()]);
    if (nextKey === deliverablesKey) return;
    deliverablesKey = nextKey;
    const panel = required('deliverables-panel');
    panel.hidden = files.length === 0;
    if (!files.length) return;
    required('deliverables-title').textContent = t('ui.deliverablesTitle');
    required('deliverables').replaceChildren(
      ...files.map((file) => {
        const item = node('li', '', 'deliverable');
        item.append(node('span', file.path, 'deliverable-path'));
        if (file.description)
          item.append(
            document.createTextNode(' — '),
            node('span', file.description, 'deliverable-description'),
          );
        // The size and the digest are what make an entry a claim about a *revision* rather than about a path, so
        // they are one hover away instead of turning the panel into a hash listing.
        item.title = `${file.bytes} B · sha256 ${file.sha256.slice(0, 12)}… · ${file.at}`;
        return item;
      }),
    );
  }
  return { todos, goal, deliverables };
}
