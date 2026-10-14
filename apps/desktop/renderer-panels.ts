/**
 * Which settings section is showing, decided in one place instead of by each section.
 *
 * The page has three panels and three modules that could each hide the other two — `renderer-settings.ts`
 * (model), `renderer-general-settings.ts` (general) and `renderer-mcp.ts` (MCP) — and every one of them used to
 * write its own list of the panels to hide. That shape is what turns "add a section" into "update every
 * switcher, and a missed update is two panels drawn at once", which is exactly what `tests/desktop.smoke.mjs`
 * asserts cannot happen ("must display exactly one settings panel").
 *
 * So the ids are data here, and a section shows itself by naming itself. The map is panel id to the sidebar
 * button that selects it, because the two are not always spelled alike: the MCP button exists only after that
 * module has run, and the panel it opens is `mcp-panel`.
 *
 * Hiding is by id rather than by walking one container's children because the panels live in two different
 * parents — two in `index.html`'s settings page, `mcp-panel` appended to it by `renderer-mcp.ts`. An entry whose
 * panel does not exist yet is simply skipped, so this answers correctly whichever module runs first.
 *
 * It lives in a module of its own rather than beside one of the three panels it switches: it was written inside
 * the environment section's module, and that section is gone (the desktop does not keep a page listing the
 * `YUANTU_*` variables it reads — see §7-8 of the ledger). A switcher owned by whichever panel happened to be
 * added last is a switcher the next removal has to go looking for.
 */
const PANELS = {
  'general-settings-content': 'general-settings',
  'model-settings-content': 'model-settings',
  'mcp-panel': 'mcp-settings',
} as const;
export type SettingsPanelId = keyof typeof PANELS;

export function showSettingsPanel(panelId: SettingsPanelId): void {
  for (const [id, buttonId] of Object.entries(PANELS)) {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = id !== panelId;
    const button = document.getElementById(buttonId);
    if (!button) continue;
    if (id === panelId) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
