/**
 * Mount the sandbox prompt into the legacy composer.
 *
 * The prompt's container replaces the static section in `index.html`, the same way the settings panels were replaced.
 * The legacy renderer still needs one thing from it — `setMode`, called when the permission chip reports which
 * sandbox the session on screen uses — so that stays on the returned handle until the composer itself moves.
 */
import type { DesktopBridge } from '../../contract.ts';
import type { SandboxMode } from '../../sandbox-settings.ts';
import { registerView } from '../views.tsx';
import { SandboxPrompt } from './SandboxPrompt.tsx';
import { createSandboxSetupController } from './sandbox-setup-model.ts';

export function mountSandboxSetup(bridge: DesktopBridge): {
  setMode(mode: SandboxMode | undefined): void;
  dispose(): void;
} {
  const host = document.getElementById('sandbox-prompt-root');
  if (!host) return { setMode() {}, dispose() {} };
  const controller = createSandboxSetupController({
    api: bridge.sandboxSetup,
  });
  const disposeRegion = registerView('sandbox-prompt', <SandboxPrompt controller={controller} />);
  void controller.start();
  return {
    setMode: (mode) => controller.setMode(mode),
    dispose: () => {
      disposeRegion();
      controller.dispose();
    },
  };
}
