/**
 * Mount the React statistics pills into the composer and answer the renderer's two calls.
 *
 * The snapshot is pushed in on a full paint; a statistics delta patches the session it names (and is ignored for any
 * other session). The popover rules live in the component.
 */
import type { SessionSnapshot } from '../../../../packages/client/session-controller.ts';
import type { StatisticsDelta } from '../../../../packages/carrier/contract.ts';
import { applyStatisticsDelta } from './statistics-model.ts';
import { createStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { Statistics } from './Statistics.tsx';

export interface StatisticsHandle {
  update(snapshot: SessionSnapshot): void;
  delta(delta: StatisticsDelta): void;
  dispose(): void;
}

export function mountStatistics(): StatisticsHandle {
  const store = createStore<SessionSnapshot | null>(null);
  const host = document.getElementById('composer-statistics');
  const disposeRegion = host ? registerView('statistics', <Statistics store={store} />) : () => {};
  return {
    update(snapshot) {
      if (store.getSnapshot() !== snapshot) store.set(snapshot);
    },
    delta(delta) {
      const next = applyStatisticsDelta(store.getSnapshot(), delta);
      if (next) store.set(next);
    },
    dispose() {
      disposeRegion();
    },
  };
}
