import { createStore } from './stores.ts';

export type DesktopPage = 'chat' | 'settings';
export type SettingsPanel =
  | 'general-settings-content'
  | 'model-settings-content'
  | 'workspace-maintenance-content'
  | 'mcp-panel';

/** Navigation survives page transitions; changing a view never recreates its form or transcript. */
export const navigation = createStore({
  page: 'chat' as DesktopPage,
  panel: 'model-settings-content' as SettingsPanel,
  workspaceOpen: false,
  workspaceFullscreen: false,
  workspaceWidth: 560,
});

export function showPage(page: DesktopPage): void {
  navigation.set({ ...navigation.getSnapshot(), page });
}

export function showPanel(panel: SettingsPanel): void {
  navigation.set({ ...navigation.getSnapshot(), panel });
}
