/**
 * Mount the React session sidebar and its rename/delete dialog into the legacy shell.
 *
 * Two containers because the dialog lives at the end of the document; one controller, so the row menu, the dialog and
 * the list agree. The sidebar's static search/list markup is replaced, while the header's new-session and
 * choose-workspace buttons stay legacy elements and are wired here to the same controller.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../../../packages/protocol/index.ts';
import { registerView } from '../views.tsx';
import { SessionDialog } from './SessionDialog.tsx';
import { SessionSidebar } from './SessionSidebar.tsx';
import { createSessionSidebarController, type SessionActivity } from './session-model.ts';

export interface SessionSidebarHandle {
  update(input: {
    sessions: SessionInfo[];
    currentId: string | null;
    blocked: boolean;
    hasMore: boolean;
    searching: boolean;
    activity: ReadonlyMap<string, SessionActivity>;
    sessionQuery?: string;
  }): void;
  dispose(): void;
}

export function mountSessionSidebar(deps: {
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}): SessionSidebarHandle {
  const listHost = document.getElementById('session-sidebar-root');
  const dialogHost = document.getElementById('session-dialog-root');
  const controller = createSessionSidebarController({ select: deps.select });
  const disposeList = listHost
    ? registerView('session-sidebar', <SessionSidebar controller={controller} />)
    : () => {};
  const disposeDialog = dialogHost
    ? registerView('session-dialog', <SessionDialog controller={controller} />)
    : () => {};
  const create = document.getElementById('new-session');
  const workspace = document.getElementById('choose-workspace');
  const onCreate = (): void => void controller.createSession();
  const onWorkspace = (): void => void controller.chooseWorkspace();
  create?.addEventListener('click', onCreate);
  workspace?.addEventListener('click', onWorkspace);
  return {
    update: (input) => controller.update(input),
    dispose: () => {
      create?.removeEventListener('click', onCreate);
      workspace?.removeEventListener('click', onWorkspace);
      disposeDialog();
      disposeList();
      controller.dispose();
    },
  };
}
