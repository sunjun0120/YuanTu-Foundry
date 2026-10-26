/**
 * Mount the React task list and keep the editor forms the legacy builders still own.
 *
 * A progress publish while a form is open updates that form's busy/stale state instead of rebuilding the list: the
 * `TaskConfirmDrafts` set and the form's fields belong to the person, not to the frame that drew them.
 */
import type { ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { TaskConfirmDrafts } from '../../task-confirm-drafts.ts';
import { useReadable } from '../context.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import { scheduleEditor, taskEditor, type EditorHost } from '../../renderer-tasks-editors.ts';
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

  const host = (
    current: () => { revision: string } | undefined,
    forget: () => void,
  ): EditorHost => ({
    send,
    button(parent, label, action, disabled = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.disabled = store.getSnapshot().busy || disabled;
      button.addEventListener('click', action);
      parent.append(button);
      return button;
    },
    snapshot: () => store.getSnapshot().snapshot,
    busy: () => store.getSnapshot().busy,
    current,
    close(next, locked) {
      forget();
      editing = null;
      render(next, locked);
    },
  });

  const actions: TaskCardActions = {
    send: (command) => void send(command),
    edit(task) {
      const built = taskEditor(
        task,
        host(
          () => editing ?? undefined,
          () => (editing = null),
        ),
      );
      editing = {
        taskId: task.id,
        form: built.form,
        revision: task.updatedAt,
        stale: false,
      };
      store.set({ ...store.getSnapshot(), editing, tick: store.getSnapshot().tick + 1 });
    },
    schedule(task) {
      const form = scheduleEditor(
        task,
        host(
          () => editing ?? undefined,
          () => (editing = null),
        ),
      );
      editing = { taskId: task.id, form, revision: task.updatedAt, stale: false };
      store.set({ ...store.getSnapshot(), editing, tick: store.getSnapshot().tick + 1 });
    },
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
  };

  function render(next: CarrierSnapshot | null, locked: boolean): void {
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
      // The open form freezes the list; only its own busy/stale state moves.
      store.set({ ...current, busy, editing, tick: current.tick + 1 });
      return;
    }
    store.set({ snapshot: next, busy, editing: null, tick: current.tick + 1 });
  }

  const root = document.getElementById('task-list');
  const disposeRegion = root
    ? mountRegion('tasks', root, <TasksHost store={store} actions={actions} />)
    : () => {};
  const handle = render as TasksHandle;
  handle.dispose = () => disposeRegion();
  return handle;
}
