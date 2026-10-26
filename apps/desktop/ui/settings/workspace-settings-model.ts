/**
 * The archived-sessions / retained-workspaces settings page as data.
 *
 * The two lists are one page and always have been: a refresh loads both, and moving to another project clears both.
 * The three things they share are the reason this is a controller rather than two components:
 *
 * - **A generation per project.** A reply for the previous project is dropped, not merged. The legacy modules both
 *   checked `reply.workspace !== project`; keeping that check here is what makes switching projects safe.
 * - **The run lock.** Archive, remove, restore and the archived page's unarchive/delete are carrier commands that
 *   wait for a run, so they are disabled while one streams — the same rule as the sidebar's menu actions.
 * - **Failure is text, not state.** A refused maintenance reply carries a `CarrierIssue`; the page formats it with
 *   `carrierErrorText` at render time, so a language change re-renders the sentence without a new request.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { HostMethods } from '../../../../packages/protocol/rpc.ts';
import type { SessionInfo } from '../../../../packages/protocol/index.ts';
import type {
  WorkspaceMaintenanceCommand,
  WorkspaceMaintenanceReply,
} from '../../workspace-maintenance-contract.ts';
import type { ArchivedSessionsReply } from '../../contract.ts';
import { t } from '../../i18n.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export type OrphanItem = HostMethods['workspaces.orphaned']['result'][number];
export type MaintenanceFailure = Extract<WorkspaceMaintenanceReply, { ok: false }>;

export interface ArchivedListState {
  items: SessionInfo[] | null;
  pending: boolean;
  error: string | null;
  confirmation: string | null;
}

export interface OrphanListState {
  items: OrphanItem[] | null;
  pending: boolean;
  failure: MaintenanceFailure | null;
  confirmation: string | null;
}

export interface WorkspaceSettingsState {
  workspace: string;
  blocked: boolean;
  archived: ArchivedListState;
  orphans: OrphanListState;
}

const emptyArchived = (): ArchivedListState => ({
  items: null,
  pending: false,
  error: null,
  confirmation: null,
});
const emptyOrphans = (): OrphanListState => ({
  items: null,
  pending: false,
  failure: null,
  confirmation: null,
});

export interface WorkspaceSettingsController {
  readonly store: ReadableStore<WorkspaceSettingsState>;
  update(snapshot: Pick<CarrierSnapshot, 'workspace' | 'ready' | 'session'>): void;
  refresh(): void;
  refreshArchived(): Promise<void>;
  refreshOrphans(): Promise<void>;
  act(bindingId: string, action: 'archive' | 'remove' | 'restore'): void;
  cancelOrphan(): void;
  unarchive(sessionId: string): void;
  removeArchived(sessionId: string): void;
  cancelArchived(): void;
  dispose(): void;
}

export function createWorkspaceSettingsController(deps: {
  maintenance(command: WorkspaceMaintenanceCommand): Promise<WorkspaceMaintenanceReply>;
  archived?(): Promise<ArchivedSessionsReply>;
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  /** Whether the settings page is on screen; a project change only reloads a visible page. */
  isVisible?(): boolean;
}): WorkspaceSettingsController {
  const store = createStore<WorkspaceSettingsState>({
    workspace: '',
    blocked: true,
    archived: emptyArchived(),
    orphans: emptyOrphans(),
  });
  let disposed = false;
  let orphanGeneration = 0;
  let archivedGeneration = 0;
  const update = (patch: Partial<WorkspaceSettingsState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const patchArchived = (patch: Partial<ArchivedListState>): void => {
    update({ archived: { ...store.getSnapshot().archived, ...patch } });
  };
  const patchOrphans = (patch: Partial<OrphanListState>): void => {
    update({ orphans: { ...store.getSnapshot().orphans, ...patch } });
  };
  const failureOf = (error: unknown): MaintenanceFailure => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });

  async function refreshArchived(): Promise<void> {
    const state = store.getSnapshot();
    const bridge = deps.archived;
    if (!state.workspace || !bridge || state.archived.pending) return;
    const at = ++archivedGeneration;
    const project = state.workspace;
    patchArchived({ pending: true, error: null });
    try {
      const reply = await bridge();
      if (disposed || at !== archivedGeneration) return;
      if (!reply.ok) patchArchived({ error: reply.error });
      else if (reply.workspace === project) patchArchived({ items: reply.sessions, error: null });
    } catch (error) {
      if (!disposed && at === archivedGeneration)
        patchArchived({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!disposed && at === archivedGeneration) patchArchived({ pending: false });
    }
  }

  async function refreshOrphans(): Promise<void> {
    const state = store.getSnapshot();
    if (!state.workspace || state.orphans.pending) return;
    const at = ++orphanGeneration;
    const project = state.workspace;
    patchOrphans({ pending: true, failure: null });
    try {
      const reply = await deps.maintenance({ type: 'list' });
      if (disposed || at !== orphanGeneration) return;
      if (reply.ok) {
        if (reply.workspace === project) patchOrphans({ items: reply.items, failure: null });
      } else patchOrphans({ failure: reply });
    } catch (error) {
      if (!disposed && at === orphanGeneration) patchOrphans({ failure: failureOf(error) });
    } finally {
      if (!disposed && at === orphanGeneration) patchOrphans({ pending: false });
    }
  }

  async function requestOrphan(
    action: 'archive' | 'remove' | 'restore',
    bindingId: string,
  ): Promise<void> {
    const state = store.getSnapshot();
    if (!state.workspace || state.orphans.pending || state.blocked) return;
    const at = ++orphanGeneration;
    const project = state.workspace;
    patchOrphans({ pending: true, failure: null, confirmation: null });
    try {
      const reply = await deps.maintenance({ type: action, bindingId });
      if (disposed || at !== orphanGeneration) return;
      if (reply.ok) {
        if (reply.workspace === project) patchOrphans({ items: reply.items, failure: null });
      } else patchOrphans({ failure: reply });
    } catch (error) {
      if (!disposed && at === orphanGeneration) patchOrphans({ failure: failureOf(error) });
    } finally {
      if (!disposed && at === orphanGeneration) patchOrphans({ pending: false });
    }
  }

  async function run(command: CarrierCommand): Promise<void> {
    const state = store.getSnapshot();
    if (state.archived.pending || state.blocked) return;
    patchArchived({ pending: true, error: null, confirmation: null });
    let done: CarrierSnapshot | null = null;
    try {
      done = await deps.select(command);
    } catch {
      done = null;
    }
    if (disposed) return;
    patchArchived({ pending: false });
    // One action, then a fresh read: the list is the Host's answer, not a local guess at what changed.
    await refreshArchived();
    if (!done && !disposed) patchArchived({ error: t('archived.failed') });
  }

  const controller: WorkspaceSettingsController = {
    store,
    update(snapshot) {
      const state = store.getSnapshot();
      const changed = state.workspace !== snapshot.workspace;
      const blocked = !snapshot.ready || snapshot.session.running || snapshot.session.loading;
      if (!changed && state.blocked === blocked) return;
      if (changed) {
        orphanGeneration++;
        archivedGeneration++;
      }
      update({
        workspace: snapshot.workspace,
        blocked,
        ...(changed ? { archived: emptyArchived(), orphans: emptyOrphans() } : {}),
      });
      if (changed && (deps.isVisible?.() ?? false)) controller.refresh();
    },
    refresh() {
      void Promise.all([refreshArchived(), refreshOrphans()]);
    },
    refreshArchived,
    refreshOrphans,
    act(bindingId, action) {
      if (store.getSnapshot().orphans.pending) return;
      if (action === 'remove' && store.getSnapshot().orphans.confirmation !== bindingId) {
        patchOrphans({ confirmation: bindingId });
        return;
      }
      void requestOrphan(action, bindingId);
    },
    cancelOrphan() {
      patchOrphans({ confirmation: null });
    },
    unarchive(sessionId) {
      void run({ type: 'archiveSession', id: sessionId, archived: false });
    },
    removeArchived(sessionId) {
      const confirmation = store.getSnapshot().archived.confirmation;
      if (confirmation !== sessionId) {
        patchArchived({ confirmation: sessionId });
        return;
      }
      void run({ type: 'deleteSession', id: sessionId });
    },
    cancelArchived() {
      patchArchived({ confirmation: null });
    },
    dispose() {
      disposed = true;
    },
  };
  return controller;
}
