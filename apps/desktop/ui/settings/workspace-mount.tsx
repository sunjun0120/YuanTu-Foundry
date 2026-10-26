/**
 * Mount the workspace settings page into the legacy settings shell.
 *
 * The shell still owns which panel is visible (`showSettingsPanel`), so this adapter keeps that seam and adds the two
 * things the page needs from it: the sidebar entry translates with the rest of the chrome, and opening the entry
 * loads both lists. A project change while the page is open reloads them through `update`.
 */
import type { DesktopBridge } from '../../contract.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { onLocaleChange, t } from '../../i18n.ts';
import { showSettingsPanel } from '../../renderer-panels.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import { WorkspaceMaintenance } from './WorkspaceMaintenance.tsx';
import { createWorkspaceSettingsController } from './workspace-settings-model.ts';

export function mountWorkspaceSettings(
  bridge: DesktopBridge,
  deps: { select(command: CarrierCommand): Promise<CarrierSnapshot | null> },
): {
  update(state: Pick<CarrierSnapshot, 'workspace' | 'ready' | 'session'>): void;
  dispose(): void;
} {
  const content = document.getElementById('workspace-maintenance-content');
  if (!content) return { update() {}, dispose() {} };
  content.replaceChildren();
  const controller = createWorkspaceSettingsController({
    maintenance: (command) => bridge.workspaceMaintenance(command),
    archived: bridge.archivedSessions ? () => bridge.archivedSessions!() : undefined,
    select: deps.select,
    isVisible: () => content.hidden === false,
  });
  const disposeRegion = mountRegion(
    'workspace-settings',
    content,
    <WorkspaceMaintenance controller={controller} />,
  );
  const label = document.getElementById('workspace-maintenance-label');
  const translate = (): void => {
    if (label) label.textContent = t('archived.title');
  };
  onLocaleChange(translate);
  translate();
  const entry = document.getElementById('workspace-maintenance-settings');
  const open = (): void => {
    showSettingsPanel('workspace-maintenance-content');
    controller.refresh();
  };
  entry?.addEventListener('click', open);
  return {
    update: (state) => controller.update(state),
    dispose: () => {
      entry?.removeEventListener('click', open);
      disposeRegion();
      controller.dispose();
    },
  };
}
