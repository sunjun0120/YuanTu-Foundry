/**
 * Mount the React task list and own the state of whichever editor is open.
 *
 * A progress publish while an editor is open updates that editor's busy/stale state instead of rebuilding the list:
 * the `TaskConfirmDrafts` set and the editor's fields belong to the person, not to the frame that drew them.
 */
import type { ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { Task } from '../../../../packages/protocol/index.ts';
import { TaskConfirmDrafts } from '../../task-confirm-drafts.ts';
import { useReadable } from '../context.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { TaskCards, type TaskCardActions, type TaskEditing } from './TasksPanel.tsx';

export interface TasksState {
  snapshot: CarrierSnapshot | null;
  busy: boolean;
  editing: TaskEditing | null;
  tick: number;
}

export type TasksHandle = ((snapshot: CarrierSnapshot | null, locked: boolean) => void) & {
  dispose(): void;
};

function TasksHost({
  store,
  actions,
}: {
  store: ReadableStore<TasksState>;
  actions: TaskCardActions;
}): ReactNode {
  const state = useReadable(store);
  if (!state.snapshot) return null;
  return (
    <TaskCards
      snapshot={state.snapshot}
      busy={state.busy}
      actions={actions}
      editing={state.editing}
    />
  );
}

export function mountTasks(
  send: (command: CarrierCommand) => Promise<CarrierSnapshot | null>,
): TasksHandle {
  const store = createStore<TasksState>({ snapshot: null, busy: false, editing: null, tick: 0 });
  const drafts = new TaskConfirmDrafts();
  let sessionKey = '';
  let editing: TaskEditing | null = null;
  let editorToken = 0;
  let latest: CarrierSnapshot | null = null;

  const open = (task: Task, mode: TaskEditing['mode']) => {
    editing = {
      taskId: task.id,
      task,
      token: ++editorToken,
      revision: task.updatedAt,
      stale: false,
      mode,
    };
    store.set({ ...store.getSnapshot(), editing, tick: store.getSnapshot().tick + 1 });
  };

  const actions: TaskCardActions = {
    send: (command) => void send(command),
    edit: (task) => open(task, 'edit'),
    schedule: (task) => open(task, 'schedule'),
    confirm(task, indices) {
      if (!indices.length) return;
      void send({
        type: 'taskConfirm',
        taskId: task.id,
        indices,
        expectedUpdatedAt: task.updatedAt,
      }).then((result) => {
        if (result) render(result, false);
      });
    },
    selection: (task) => drafts.selection(sessionKey, task),
    selectionChanged() {
      store.set({ ...store.getSnapshot(), tick: store.getSnapshot().tick + 1 });
    },
    async save(command, open) {
      if (
        editing?.token !== open.token ||
        editing.stale ||
        store.getSnapshot().busy ||
        latest?.tasks.find((task) => task.id === open.taskId)?.updatedAt !== open.revision
      )
        return;
      const result = await send(command);
      if (!result || editing?.token !== open.token) return;
      editing = null;
      render(result, false);
    },
    cancel() {
      editing = null;
      render(latest, store.getSnapshot().busy);
    },
  };

  function render(next: CarrierSnapshot | null, locked: boolean): void {
    latest = next;
    const busy = locked || !!next?.session.running || !!next?.session.loading;
    const nextSession = `${next?.workspace}:${next?.session.sessionId}`;
    if (sessionKey !== nextSession) {
      sessionKey = nextSession;
      editing = null;
    }
    drafts.retain(
      sessionKey,
      (next?.tasks ?? []).map((task) => task.id),
    );
    const panel = document.getElementById('tasks-panel');
    if (panel) panel.hidden = !next?.tasks.length;
    const current = store.getSnapshot();
    if (editing) {
      const task = next?.tasks.find((entry) => entry.id === editing!.taskId);
      const stale = task?.updatedAt !== editing.revision;
      if (editing.stale !== stale) editing = { ...editing, stale };
      // The open editor freezes the list; only its own busy/stale state moves.
      store.set({ ...current, busy, editing, tick: current.tick + 1 });
      return;
    }
    store.set({ snapshot: next, busy, editing: null, tick: current.tick + 1 });
  }

  const root = document.getElementById('task-list');
  const disposeRegion = root
    ? registerView('tasks', <TasksHost store={store} actions={actions} />)
    : () => {};
  const handle = render as TasksHandle;
  handle.dispose = () => disposeRegion();
  return handle;
}
