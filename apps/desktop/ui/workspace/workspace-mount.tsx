/**
 * Mount the React workspace panel and keep the two seams the legacy window still owns.
 *
 * The opener (`#open-workspace`) is a static button in the chat header: this adapter gives it the panel icon and
 * toggles the panel. Everything else — the tree, preview, tabs, resize, fullscreen — lives in React. The returned
 * handle is the same surface `renderer.ts` used from `setupWorkspace`.
 */
import type { FilesCommand, FilesReply } from '../../files-contract.ts';
import { locale, t } from '../../i18n.ts';
import { workspaceIcon } from '../../workspace-icons.ts';
import { registerView } from '../views.tsx';
import { WorkspacePanel } from './WorkspacePanel.tsx';
import { createWorkspaceController } from './workspace-model.ts';

export interface WorkspaceHandle {
  update(workspace: string): void;
  open(path: string): Promise<void>;
  refresh(): void;
  previewChanges(path: string, content: Element, key: string): void;
  refreshChangePreview(key: string, content: Element): boolean;
  clearChangePreviews(): void;
  dispose(): void;
}

export function mountWorkspace(deps: {
  files(command: FilesCommand): Promise<FilesReply>;
}): WorkspaceHandle {
  const host = document.getElementById('workspace-root');
  const controller = createWorkspaceController({
    files: deps.files,
    locale: () => locale(),
  });
  const markdownActions = {
    async copy(text: string) {
      const reply = await window.yuantu.invoke({ type: 'copyText', text });
      if (!reply.ok) throw new Error(reply.error);
    },
    async open(url: string) {
      const reply = await window.yuantu.invoke({ type: 'openLink', url });
      if (!reply.ok) throw new Error(reply.error);
    },
    async openLocal(path: string) {
      const reply = await window.yuantu.openWorkspacePath?.(path, 'open');
      if (!reply?.ok) throw new Error(reply?.error ?? 'Open failed');
    },
  };
  const disposeRegion = host
    ? registerView(
        'workspace',
        <WorkspacePanel controller={controller} markdownActions={markdownActions} />,
      )
    : () => {};
  const opener = document.getElementById('open-workspace') as HTMLButtonElement | null;
  if (opener) {
    opener.replaceChildren(workspaceIcon('expand'));
    opener.dataset.tooltip = t('workspace.openTitle');
    opener.setAttribute('aria-label', t('workspace.title'));
  }
  const toggle = (): void => {
    const state = controller.store.getSnapshot();
    if (state.open) {
      controller.setOpen(false);
      return;
    }
    controller.setOpen(true);
    // R7: the top entry opens the chooser, not the file tree; files load only when that entry is chosen.
    controller.openNewTab();
  };
  opener?.addEventListener('click', toggle);
  const onFocus = (): void => {
    const state = controller.store.getSnapshot();
    if (state.open && state.active.kind !== 'new') controller.refresh();
  };
  window.addEventListener('focus', onFocus);
  // A cheap listing comparison, not a watcher: a poll that finds no change draws nothing and leaves scroll/tabs alone.
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void controller.pollForChanges().finally(() => {
      polling = false;
    });
  }, 4000);
  return {
    update(workspace) {
      controller.setWorkspace(workspace);
    },
    async open(path) {
      controller.setOpen(true);
      const state = controller.store.getSnapshot();
      if (state.workspace && !state.listings.has('')) void controller.loadDirectory('');
      await controller.showFile(path);
    },
    refresh() {
      controller.refresh();
    },
    previewChanges(path, content, key) {
      controller.previewChanges(path, content, key);
    },
    refreshChangePreview(key, content) {
      return controller.refreshChangePreview(key, content);
    },
    clearChangePreviews() {
      controller.clearChangePreviews();
    },
    dispose() {
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
      opener?.removeEventListener('click', toggle);
      disposeRegion();
      controller.dispose();
    },
  };
}
