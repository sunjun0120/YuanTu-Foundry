/**
 * Mount the permission chip and the full-access dialog, both over one controller.
 *
 * Two containers because the dialog lives at the end of the document (outside the composer's stacking context) while
 * the chip sits in the composer toolbar; both render from the same state, so opening the dialog from the chip or from
 * the completion card's "open full access" action is the same act.
 */
import type { DesktopBridge } from '../../contract.ts';
import type { SandboxMode } from '../../sandbox-settings.ts';
import { registerView } from '../views.tsx';
import { FullAccessDialog } from './FullAccessDialog.tsx';
import { PermissionChip } from './PermissionChip.tsx';
import { createPermissionController } from './permission-model.ts';

export interface PermissionHandle {
  updateBusy(): void;
  refresh(): void;
  requestFullAccess(): void;
  dispose(): void;
}

export function mountPermissions(
  bridge: DesktopBridge,
  deps: {
    isReady(): boolean;
    onBusy(busy: boolean): void;
    onSandboxMode(mode: SandboxMode | undefined): void;
  },
): PermissionHandle {
  const chipHost = document.getElementById('permission-root');
  const dialogHost = document.getElementById('full-access-root');
  const controller = createPermissionController({
    presets: bridge.presets,
    subscribePresets: bridge.subscribePresets,
    isReady: deps.isReady,
    onBusy: deps.onBusy,
    onSandboxMode: deps.onSandboxMode,
    notify: (message) => window.alert(message),
  });
  const windowsHost = /Windows/i.test(navigator.userAgent);
  const disposeChip = chipHost
    ? registerView(
        'permission-chip',
        <PermissionChip controller={controller} windowsHost={windowsHost} />,
      )
    : () => {};
  const disposeDialog = dialogHost
    ? registerView('permission-dialog', <FullAccessDialog controller={controller} />)
    : () => {};
  return {
    updateBusy: () => controller.updateBusy(),
    refresh: () => controller.refresh(),
    requestFullAccess: () => controller.requestFullAccess(),
    dispose: () => {
      disposeDialog();
      disposeChip();
      controller.dispose();
    },
  };
}
