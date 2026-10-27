/**
 * Which settings section is showing, decided in one place instead of by each section.
 *
 * The page has four panels: three React sections inside `#settings-page`, plus the dormant `#mcp-panel` that
 * `renderer-mcp.ts` appends only while `PRODUCT_SCOPE.mcpManagement` is on. Each panel used to hide the others itself,
 * which turns "add a section" into "update every switcher, and a missed update is two panels drawn at once" — exactly
 * what `tests/desktop.smoke.mjs` asserts cannot happen ("must display exactly one settings panel").
 *
 * So the ids are data here, and a section shows itself by naming itself. The map is panel id to the sidebar button that
 * selects it, because the two are not always spelled alike (`mcp-settings` opens `mcp-panel`). Hiding is by id rather
 * than by walking one container's children, because the dormant panel is appended outside the React page; an entry
 * whose panel does not exist yet is simply skipped.
 */
import { showPanel } from '../navigation.ts';

const PANELS = {
  'workspace-maintenance-content': 'workspace-maintenance-settings',
  'general-settings-content': 'general-settings',
  'model-settings-content': 'model-settings',
  'mcp-panel': 'mcp-settings',
} as const;
export type SettingsPanelId = keyof typeof PANELS;

export function showSettingsPanel(panelId: SettingsPanelId): void {
  showPanel(panelId);
  // MCP management is feature-gated and still owns its isolated legacy panel; ordinary settings are React-owned.
  const panel = document.getElementById('mcp-panel');
  if (panel) panel.hidden = panelId !== 'mcp-panel';
  const button = document.getElementById('mcp-settings');
  if (panelId === 'mcp-panel') button?.setAttribute('aria-current', 'page');
  else button?.removeAttribute('aria-current');
}
