import type { ModelSettingsView } from '../../settings-contract.ts';
import { createStore } from '../stores.ts';

export const modelPicker = createStore<{
  view: ModelSettingsView | null;
  locked: boolean;
  status: { key: string } | { text: string } | null;
  choose(id: string): void;
}>({ view: null, locked: true, status: null, choose: () => {} });
