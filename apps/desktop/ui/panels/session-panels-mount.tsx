/**
 * Mount the goal and checklist panels and answer the renderer's calls.
 *
 * These live outside the transcript; presented files belong to each turn inside the conversation.
 */
import type { ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { TodoItem } from '../../../../packages/protocol/index.ts';
import type { Goal } from '../../../../packages/protocol/goals.ts';
import { useReadable } from '../context.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { GoalPanel, TodosPanel } from './SessionPanels.tsx';

export interface SessionPanelsState {
  snapshot: CarrierSnapshot | null;
  todos: TodoItem[];
  goal: Goal | null;
}

export interface SessionPanelsHandle {
  todos(todos: TodoItem[]): void;
  goal(goal: Goal | null): void;
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
export function mountSessionPanels(getState: () => CarrierSnapshot | null): SessionPanelsHandle {
  const store = createStore<SessionPanelsState>({
    snapshot: null,
    todos: [],
    goal: null,
  });
  const mounts: (() => void)[] = [];
  const mount = (id: string, node: ReactNode): void => {
    const host = document.getElementById(id);
    if (host) mounts.push(registerView(id, node));
  };
  mount('todos-root', <TodosHost store={store} />);
  mount('goal-root', <GoalHost store={store} />);
  return {
    todos(todos) {
      store.set({ ...store.getSnapshot(), snapshot: getState(), todos });
    },
    goal(goal) {
      store.set({ ...store.getSnapshot(), goal });
    },
    dispose() {
      for (const dispose of mounts.splice(0)) dispose();
    },
  };
}
