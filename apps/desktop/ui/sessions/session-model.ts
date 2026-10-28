/**
 * The session sidebar's state: the list window, the row menu, the search box and the rename/delete dialog.
 *
 * The legacy sidebar was three modules sharing one document: the list rebuilt rows on a key, the management module
 * owned a popup menu and the dialog, and the search box was wired beside them. The rules worth keeping are small and
 * easy to lose in a rewrite:
 *
 * - the list is a **window** over the newest sessions (five rows, then "show more"); a search shows every match;
 * - a row says whether its session runs or waits on a person, and that status is not a reason to disable the row —
 *   several sessions run at once, and switching to another one must stay possible;
 * - rename edits the row in place and delete asks in a dialog (both share `dialog`); an empty rename is refused
 *   before anything is sent, and a failed command keeps the field or dialog open with the reason;
 * - the menu and dialog are refused while the window is blocked (a run that must not be disturbed).
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../../../packages/protocol/index.ts';
import { t } from '../../i18n.ts';
import { createStore, type ReadableStore } from '../stores.ts';

/** Rows shown before "show more"; a search always shows every match. */
export const COLLAPSED_ROWS = 3;

/** What a row says about its session's live run: running at all, and how many interactions wait on a person. */
export interface SessionActivity {
  running: boolean;
  waiting: number;
}

export type DialogKind = 'rename' | 'delete';

export interface SessionDialogState {
  kind: DialogKind;
  targetId: string;
  title: string;
  value: string;
  error: string;
  saving: boolean;
}

export interface SessionSidebarState {
  sessions: SessionInfo[];
  currentId: string | null;
  blocked: boolean;
  hasMore: boolean;
  searching: boolean;
  activity: ReadonlyMap<string, SessionActivity>;
  expanded: boolean;
  searchOpen: boolean;
  query: string;
  menuSessionId: string | null;
  dialog: SessionDialogState | null;
}

export interface SessionSidebarController {
  readonly store: ReadableStore<SessionSidebarState>;
  /** Feed one carrier snapshot (or the subset the list needs). */
  update(input: {
    workspaceKey?: string;
    sessions: SessionInfo[];
    currentId: string | null;
    blocked: boolean;
    hasMore?: boolean;
    searching?: boolean;
    activity?: ReadonlyMap<string, SessionActivity>;
    sessionQuery?: string;
  }): void;
  toggleExpanded(): void;
  loadMore(): void;
  openMenu(sessionId: string): void;
  closeMenu(): void;
  openSearch(): void;
  closeSearch(): void;
  setQuery(query: string): void;
  /** Send a debounced search; the component owns the timer, the controller owns the command. */
  submitQuery(query: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  createSession(): Promise<void>;
  chooseWorkspace(): Promise<void>;
  openDialog(kind: DialogKind, sessionId: string): void;
  setDialogValue(value: string): void;
  confirmDialog(): Promise<void>;
  cancelDialog(): void;
  dispose(): void;
}

/** How long ago a session started, in the row's compact form ("10小时", "3d"). */
export function sessionAge(createdAt: string | number, language: string): string {
  const then = new Date(createdAt);
  const minutes = Math.max(0, Math.floor((Date.now() - then.getTime()) / 60_000));
  const unit = (value: number, name: 'minute' | 'hour' | 'day'): string =>
    new Intl.NumberFormat(language, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(
      value,
    );
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute');
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), 'hour');
  if (minutes < 30 * 24 * 60) return unit(Math.floor(minutes / (24 * 60)), 'day');
  return then.toLocaleDateString(language, { month: 'short', day: 'numeric' });
}

/** The row's title: its own, or the untitled-session label; never an empty button. */
export function sessionTitle(item: Pick<SessionInfo, 'id' | 'title'>): string {
  return item.title || t('ui.untitledSession');
}

export function visibleSessions(
  state: Pick<SessionSidebarState, 'sessions' | 'expanded' | 'searching'>,
): SessionInfo[] {
  if (state.expanded || state.searching) return state.sessions;
  return state.sessions.slice(0, COLLAPSED_ROWS);
}

export function sessionsFoldable(
  state: Pick<SessionSidebarState, 'sessions' | 'hasMore' | 'searching'>,
): boolean {
  return !state.searching && (state.sessions.length > COLLAPSED_ROWS || state.hasMore);
}

export function sessionStatusLabel(activity: SessionActivity | undefined): string {
  if (!activity) return '';
  if (activity.waiting) return t('ui.sessionWaitingLabel', { count: activity.waiting });
  if (activity.running) return t('ui.sessionRunning');
  return '';
}

/** The row's tooltip: its title, then the live state when there is one. */
export function sessionTooltip(
  item: Pick<SessionInfo, 'id' | 'title'>,
  activity: SessionActivity | undefined,
): string {
  const label = sessionStatusLabel(activity);
  return `${sessionTitle(item)}${label ? `\n${label}` : ''}`;
}

export function createSessionSidebarController(deps: {
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}): SessionSidebarController {
  const store = createStore<SessionSidebarState>({
    sessions: [],
    currentId: null,
    blocked: true,
    hasMore: false,
    searching: false,
    activity: new Map(),
    expanded: false,
    searchOpen: false,
    query: '',
    menuSessionId: null,
    dialog: null,
  });
  let disposed = false;
  let workspaceKey = '';
  const saved = new Map<string, Pick<SessionSidebarState, 'expanded' | 'searchOpen' | 'query'>>();
  const update = (patch: Partial<SessionSidebarState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const run = async (command: CarrierCommand): Promise<CarrierSnapshot | null> => {
    try {
      return await deps.select(command);
    } catch {
      return null;
    }
  };

  return {
    store,
    update(input) {
      if (input.workspaceKey !== undefined && input.workspaceKey !== workspaceKey) {
        const previous = store.getSnapshot();
        saved.set(workspaceKey, {
          expanded: previous.expanded,
          searchOpen: previous.searchOpen,
          query: previous.query,
        });
        workspaceKey = input.workspaceKey;
        update({
          ...(saved.get(workspaceKey) ?? { expanded: false, searchOpen: false, query: '' }),
          menuSessionId: null,
          dialog: null,
        });
      }
      const state = store.getSnapshot();
      // A snapshot must not overwrite what the person is typing: sync the query only while the box is closed.
      const query = state.searchOpen ? state.query : (input.sessionQuery ?? '');
      update({
        sessions: input.sessions,
        currentId: input.currentId,
        blocked: input.blocked,
        hasMore: input.hasMore ?? false,
        searching: input.searching ?? false,
        activity: input.activity ?? new Map(),
        query,
      });
    },
    toggleExpanded() {
      const state = store.getSnapshot();
      update({ expanded: !state.expanded });
    },
    loadMore() {
      if (store.getSnapshot().blocked) return;
      void run({ type: 'loadMoreSessions' });
    },
    openMenu(sessionId) {
      if (store.getSnapshot().blocked) return;
      update({ menuSessionId: sessionId });
    },
    closeMenu() {
      update({ menuSessionId: null });
    },
    openSearch() {
      if (store.getSnapshot().blocked) return;
      update({ searchOpen: true, query: '' });
    },
    closeSearch() {
      // Closing the box discards the query; the list is re-read unfiltered by the caller.
      update({ searchOpen: false, query: '' });
    },
    setQuery(query) {
      update({ query });
    },
    async submitQuery(query) {
      await run({ type: 'searchSessions', query });
    },
    async selectSession(sessionId) {
      if (store.getSnapshot().blocked) return;
      update({ menuSessionId: null });
      await run({ type: 'load', id: sessionId });
    },
    async createSession() {
      if (store.getSnapshot().blocked) return;
      await run({ type: 'create' });
    },
    async chooseWorkspace() {
      if (store.getSnapshot().blocked) return;
      await run({ type: 'chooseWorkspace' });
    },
    openDialog(kind, sessionId) {
      const state = store.getSnapshot();
      if (state.blocked) return;
      const item = state.sessions.find((entry) => entry.id === sessionId);
      if (!item) return;
      update({
        menuSessionId: null,
        dialog: {
          kind,
          targetId: sessionId,
          title: item.title || t('ui.untitledSession'),
          value: item.title || '',
          error: '',
          saving: false,
        },
      });
    },
    setDialogValue(value) {
      const state = store.getSnapshot();
      if (!state.dialog) return;
      update({ dialog: { ...state.dialog, value, error: '' } });
    },
    async confirmDialog() {
      const state = store.getSnapshot();
      const dialog = state.dialog;
      if (!dialog || state.blocked || dialog.saving) return;
      const command: CarrierCommand =
        dialog.kind === 'rename'
          ? { type: 'rename', id: dialog.targetId, title: dialog.value.trim() }
          : { type: 'deleteSession', id: dialog.targetId };
      if (command.type === 'rename' && !command.title) {
        update({ dialog: { ...dialog, error: t('session.enterName') } });
        return;
      }
      update({ dialog: { ...dialog, saving: true, error: '' } });
      const result = await run(command);
      const latest = store.getSnapshot().dialog;
      if (!latest || latest.targetId !== dialog.targetId || latest.kind !== dialog.kind) return;
      if (result) update({ dialog: null });
      else update({ dialog: { ...latest, saving: false, error: t('session.operationFailed') } });
    },
    cancelDialog() {
      const state = store.getSnapshot();
      if (!state.dialog || state.dialog.saving) return;
      update({ dialog: null });
    },
    dispose() {
      disposed = true;
    },
  };
}

/** The dialog's description text, shared by the component and the tests. */
export function dialogDescription(dialog: SessionDialogState): string {
  if (dialog.kind === 'delete') {
    const title = dialog.title;
    return t('session.deleteDescription', { title });
  }
  return t('session.renameDescription');
}

/** True when the search box has no matches and should say so. */
export function searchEmpty(state: SessionSidebarState): boolean {
  return state.searchOpen && state.sessions.length === 0 && Boolean(state.query.trim());
}
