/**
 * Mount the three session panels and answer the renderer's calls.
 *
 * They are separate roots because they live in three places around the transcript (the goal above the reading area,
 * the presented files beside it, and the checklist above the composer). One store feeds all three.
 */
import type { ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { TodoItem } from '../../../../packages/protocol/index.ts';
import type { Goal } from '../../../../packages/protocol/goals.ts';
import type { PresentedFile } from '../../../../packages/protocol/deliverables.ts';
import { useReadable } from '../context.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { DeliverablesPanel, GoalPanel, TodosPanel } from './SessionPanels.tsx';

export interface SessionPanelsState {
  snapshot: CarrierSnapshot | null;
  todos: TodoItem[];
  goal: Goal | null;
  files: PresentedFile[];
}

export interface SessionPanelsHandle {
  todos(todos: TodoItem[]): void;
  goal(goal: Goal | null): void;
  deliverables(files: PresentedFile[]): void;
  dispose(): void;
}

function TodosHost({ store }: { store: ReadableStore<SessionPanelsState> }): ReactNode {
  const state = useReadable(store);
  return <TodosPanel snapshot={state.snapshot} todos={state.todos} />;
}
function GoalHost({ store }: { store: ReadableStore<SessionPanelsState> }): ReactNode {
  const state = useReadable(store);
  return <GoalPanel goal={state.goal} />;
}
function DeliverablesHost({
  store,
  open,
  shell,
}: {
  store: ReadableStore<SessionPanelsState>;
  open?: (path: string) => void;
  shell?: { open(path: string): void; reveal(path: string): void };
}): ReactNode {
  const state = useReadable(store);
  return <DeliverablesPanel files={state.files} open={open} shell={shell} />;
}

export function mountSessionPanels(
  getState: () => CarrierSnapshot | null,
  open?: (path: string) => void,
  shell?: { open(path: string): void; reveal(path: string): void },
): SessionPanelsHandle {
  const store = createStore<SessionPanelsState>({
    snapshot: null,
    todos: [],
    goal: null,
    files: [],
  });
  const mounts: (() => void)[] = [];
  const mount = (id: string, node: ReactNode): void => {
    const host = document.getElementById(id);
    if (host) mounts.push(registerView(id, node));
  };
  mount('todos-root', <TodosHost store={store} />);
  mount('goal-root', <GoalHost store={store} />);
  mount('deliverables-root', <DeliverablesHost store={store} open={open} shell={shell} />);
  return {
    todos(todos) {
      store.set({ ...store.getSnapshot(), snapshot: getState(), todos });
    },
    goal(goal) {
      store.set({ ...store.getSnapshot(), goal });
    },
    deliverables(files) {
      store.set({ ...store.getSnapshot(), files });
    },
    dispose() {
      for (const dispose of mounts.splice(0)) dispose();
    },
  };
}
