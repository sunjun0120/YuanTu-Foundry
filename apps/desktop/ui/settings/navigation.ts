/**
 * Which settings section is showing, decided in one place instead of by each section.
 *
 * The three React sections share the same navigation store; selecting a section updates the page atomically.
 */
import { showPanel } from '../navigation.ts';

const PANELS = {
  'workspace-maintenance-content': 'workspace-maintenance-settings',
  'general-settings-content': 'general-settings',
  'model-settings-content': 'model-settings',
} as const;
export type SettingsPanelId = keyof typeof PANELS;

export function showSettingsPanel(panelId: SettingsPanelId): void {
  showPanel(panelId);
}
