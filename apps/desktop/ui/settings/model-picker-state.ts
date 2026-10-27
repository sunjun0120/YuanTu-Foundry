import type { ModelSettingsView } from '../../settings-contract.ts';
import { createStore } from '../stores.ts';

export const modelPicker = createStore<{
  view: ModelSettingsView | null;
  locked: boolean;
  status: { key: string } | { text: string } | null;
  choose(id: string): void;
}>({ view: null, locked: true, status: null, choose: () => {} });

/**
 * The composer field width for a measured label.
 *
 * 40px covers the 8px left padding, the 28px right padding and 4px of slack; the arrow sits inside that right padding.
 * The 72px floor keeps the control clickable, and `compact` right-aligns the text so the floor does not open a gap
 * before the arrow.
 */
export function modelFieldWidth(labelWidth: number): { width: number; compact: boolean } {
  const raw = Math.ceil(labelWidth) + 40;
  return { width: Math.min(360, Math.max(72, raw)), compact: labelWidth > 0 && raw < 72 };
}
