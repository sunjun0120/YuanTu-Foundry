/**
 * The model-settings form as data: grouping, drafts, the group payload, validation and picker options.
 *
 * The old module built all of this while it was also drawing rows and owning the window's settings page. The pieces
 * that decide *what* is sent — which group is being edited, what a blank row means, when a draft is refused because
 * two rows share a model id — are pure and can be tested without a window, which is what this file is for.
 *
 * Two invariants travel with the data:
 *
 * - the picker's `__settings__` entry is an **action**, not a connection id; it never appears in `pickerOptions()`
 *   and can never be sent as `activeConnectionId` or as a select target;
 * - a group's rows carry the host's own bounds (`modelLimitRange`), so the form cannot accept a number the contract
 *   refuses or refuse one it accepts.
 */
import { modelLimitRange } from '../../../../packages/protocol/settings.ts';
import { t, translate } from '../../i18n.ts';
import type { DesktopBridge } from '../../contract.ts';
import type {
  ModelConnectionView,
  ModelGroupInput,
  ModelSettingsView,
} from '../../settings-contract.ts';
import { createStore, type ReadableStore } from '../stores.ts';

/** One editable row; the same shape the contract sends, with empty limits read as `null`. */
export type ModelDraftModel = ModelGroupInput['models'][number];

export interface ModelDraft {
  groupId: string;
  name: string;
  protocol: ModelGroupInput['protocol'];
  baseUrl: string;
  apiKey: string;
  models: ModelDraftModel[];
  activeConnectionId?: string;
}

export const DEFAULT_OPENAI_URL = 'https://api.openai.com';
export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';

/** The launch environment can be carrying the model while no connection is saved; that is not "nothing configured". */
export function environmentModelLabel(
  view: Pick<ModelSettingsView, 'source' | 'model'>,
  english: boolean,
): string | null {
  if (view.source !== 'environment' || !view.model) return null;
  return translate('settings.environmentModel', english ? 'en-US' : 'zh-CN', {
    model: view.model,
  });
}

/** Connections keyed by group, in the order the host listed them (which is the order the picker shows). */
export function groupConnections(
  view: Pick<ModelSettingsView, 'connections'>,
): Map<string, ModelConnectionView[]> {
  const groups = new Map<string, ModelConnectionView[]>();
  for (const entry of view.connections) {
    const entries = groups.get(entry.groupId) ?? [];
    entries.push(entry);
    groups.set(entry.groupId, entries);
  }
  return groups;
}

/** One model row from a saved connection, or the view itself when it is the environment's single reading. */
export function modelFromConnection(entry: Partial<ModelConnectionView>): ModelDraftModel {
  return {
    connectionId: entry.connectionId ?? '',
    model: entry.model ?? '',
    name: entry.name ?? entry.model ?? '',
    supportsVision: entry.supportsVision ?? true,
    maxContextTokens: entry.maxContextTokens ?? null,
    maxOutputTokens: entry.maxOutputTokens ?? null,
    autoCompactTokens: entry.autoCompactTokens ?? null,
    streamIdleTimeoutMs: entry.streamIdleTimeoutMs ?? null,
  };
}

export function blankModel(): ModelDraftModel {
  return modelFromConnection({});
}

/** A blank group for "new endpoint": one empty row, OpenAI defaults. */
export function blankDraft(): ModelDraft {
  return {
    groupId: '',
    name: '',
    protocol: 'openai',
    baseUrl: DEFAULT_OPENAI_URL,
    apiKey: '',
    models: [blankModel()],
  };
}

/**
 * What the form shows for one group.
 *
 * A group id that is not in the view is a new endpoint: empty name, OpenAI protocol, one empty row. The environment
 * reading is not a saved group, so editing "no group" while the environment supplies the model starts from that
 * reading rather than from an empty form.
 */
export function draftForGroup(
  view: Pick<
    ModelSettingsView,
    | 'source'
    | 'connections'
    | 'groupId'
    | 'groupName'
    | 'connectionId'
    | 'name'
    | 'model'
    | 'supportsVision'
    | 'maxContextTokens'
    | 'maxOutputTokens'
    | 'autoCompactTokens'
    | 'streamIdleTimeoutMs'
    | 'protocol'
    | 'baseUrl'
    | 'hasKey'
    | 'activeConnectionId'
  >,
  groupId: string,
): ModelDraft {
  const entries = groupConnections(view).get(groupId) ?? [];
  if (!entries.length && groupId !== '') return blankDraft();
  const first = entries[0];
  const environment = !entries.length && view.source === 'environment' ? view : undefined;
  const source = first ?? environment;
  const baseUrl = source?.baseUrl || DEFAULT_OPENAI_URL;
  return {
    groupId,
    name: source?.groupName || '',
    protocol: source?.protocol ?? 'openai',
    baseUrl,
    apiKey: '',
    models: entries.length
      ? entries.map((entry) => modelFromConnection(entry))
      : [environment ? modelFromConnection(environment) : blankModel()],
    activeConnectionId: view.activeConnectionId ?? undefined,
  };
}

/** The payload the host validates; empty number fields become `null`, matching the legacy form. */
export function toGroupInput(draft: ModelDraft): ModelGroupInput {
  return {
    groupId: draft.groupId,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    models: draft.models.map((model) => ({
      connectionId: model.connectionId,
      model: model.model,
      name: model.name || model.model,
      supportsVision: model.supportsVision,
      maxContextTokens: model.maxContextTokens ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      autoCompactTokens: model.autoCompactTokens ?? null,
      streamIdleTimeoutMs: model.streamIdleTimeoutMs ?? null,
    })),
    activeConnectionId: draft.activeConnectionId,
  };
}

/** `null` when the draft may be sent; otherwise the dictionary key of the message. */
export function validateDraft(
  draft: ModelDraft,
): 'settings.atLeastOne' | 'settings.duplicateModel' | null {
  if (!draft.models.length) return 'settings.atLeastOne';
  const names = draft.models.map((model) => model.model.trim());
  if (new Set(names).size !== names.length) return 'settings.duplicateModel';
  return null;
}

/**
 * The picker's selectable options: saved connections only.
 *
 * The settings entry is deliberately absent — it is a button, not a connection id. When nothing is saved the
 * environment reading is kept as a disabled-looking option with an empty value, because the picker still has to say
 * which model is answering.
 */
export function pickerOptions(
  view: Pick<ModelSettingsView, 'source' | 'model' | 'connections'> & {
    connectionId?: string;
  },
  labels: { noModel: string; environment: boolean },
): { value: string; label: string }[] {
  if (!view.connections.length) {
    const environment = environmentModelLabel(view, labels.environment);
    return [{ value: '', label: environment ?? labels.noModel }];
  }
  return view.connections.map((entry) => ({ value: entry.connectionId, label: entry.model }));
}

/** The host's own bounds for one limit, so the inputs and the validator cannot disagree. */
export function limitsFor(
  property: 'maxContextTokens' | 'maxOutputTokens' | 'autoCompactTokens' | 'streamIdleTimeoutMs',
): { min: number; max: number } {
  const [min, max] = modelLimitRange(property);
  return { min, max };
}

/** The URL the form suggests when the protocol changes and the current URL is one of the defaults. */
export function protocolDefaultUrl(protocol: ModelGroupInput['protocol']): string {
  return protocol === 'anthropic' ? DEFAULT_ANTHROPIC_URL : DEFAULT_OPENAI_URL;
}

/** The group picker's entries; the blank "new endpoint" entry appears only while a new one is being edited. */
export function groupChoices(
  view: Pick<ModelSettingsView, 'connections' | 'activeConnectionId'>,
  editingGroupId: string,
  labels: { currentDefault: string; newEndpoint: string },
): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [];
  for (const [id, entries] of groupConnections(view)) {
    const first = entries[0]!;
    const isDefault = entries.some((entry) => entry.connectionId === view.activeConnectionId);
    choices.push({
      value: id,
      label: first.groupName + (isDefault ? ` · ${labels.currentDefault}` : ''),
    });
  }
  if (!editingGroupId) choices.push({ value: '', label: labels.newEndpoint });
  return choices;
}

export interface ModelSettingsState {
  view: ModelSettingsView | null;
  draft: ModelDraft | null;
  pending: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  switchStatus: string | null;
}

export interface ModelSettingsController {
  readonly store: ReadableStore<ModelSettingsState>;
  refresh(): Promise<void>;
  selectGroup(groupId: string): void;
  newGroup(): void;
  cancel(): void;
  update(patch: Partial<Omit<ModelDraft, 'models'>>): void;
  updateModel(index: number, patch: Partial<ModelDraftModel>): void;
  addModel(): void;
  removeModel(index: number): void;
  save(): Promise<void>;
  test(): Promise<void>;
  discover(): Promise<void>;
  selectConnection(connectionId: string): Promise<void>;
  setBusy(busy: boolean): void;
  dispose(): void;
}

/**
 * The model-settings panel's state machine.
 *
 * `pending` is the form's own write; `busy` is the window's (a run is streaming). Both lock the form, because a
 * switch or a save while a run is using the connection is exactly the race the legacy `updateBusy` prevented. Every
 * command is guarded by the same `locked()`, so a slow answer cannot be overtaken by a click.
 */
export function createModelSettingsController(deps: {
  bridge: Pick<DesktopBridge, 'settings'>;
  /** Called when the form starts/finishes a write, so the legacy picker and the page can lock too. */
  onPending?(pending: boolean): void;
  busy?: boolean;
}): ModelSettingsController {
  const store = createStore<ModelSettingsState>({
    view: null,
    draft: null,
    pending: false,
    busy: deps.busy ?? false,
    error: null,
    message: null,
    switchStatus: null,
  });
  let disposed = false;

  const update = (patch: Partial<ModelSettingsState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const locked = (): boolean => {
    const state = store.getSnapshot();
    return state.pending || state.busy || state.draft === null;
  };
  const setPending = (pending: boolean): void => {
    update({ pending });
    deps.onPending?.(pending);
  };
  const adopt = (view: ModelSettingsView): void => {
    const draft = draftForGroup(view, view.groupId || view.connections[0]?.groupId || '');
    update({
      view,
      draft,
      error: view.error ?? null,
      message: null,
      switchStatus: null,
    });
  };
  const messageOf = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : t('settings.connectionError');

  const refresh = async (): Promise<void> => {
    if (store.getSnapshot().pending) return;
    setPending(true);
    try {
      const reply = await deps.bridge.settings({ type: 'get' });
      if (disposed) return;
      if (reply.ok) adopt(reply.settings);
      else update({ error: reply.error, message: null });
    } catch (error) {
      if (!disposed) update({ error: messageOf(error), message: null });
    } finally {
      if (!disposed) setPending(false);
    }
  };

  const draftOrNull = (): ModelDraft | null => store.getSnapshot().draft;
  const patchModel = (index: number, patch: Partial<ModelDraftModel>): void => {
    const draft = draftOrNull();
    if (!draft || index < 0 || index >= draft.models.length) return;
    const models = draft.models.map((model, at) => (at === index ? { ...model, ...patch } : model));
    update({ draft: { ...draft, models }, error: null });
  };

  const submit = async (kind: 'save-group' | 'test'): Promise<void> => {
    const state = store.getSnapshot();
    const draft = state.draft;
    if (!draft || locked()) return;
    const invalid = validateDraft(draft);
    if (invalid) {
      update({ error: t(invalid), message: null });
      return;
    }
    setPending(true);
    update({ error: null, message: null });
    try {
      const reply =
        kind === 'test'
          ? await deps.bridge.settings({
              type: 'test',
              values: {
                ...draft.models[0]!,
                connectionId: draft.models[0]!.connectionId,
                protocol: draft.protocol,
                baseUrl: draft.baseUrl,
                apiKey: draft.apiKey,
              },
            })
          : await deps.bridge.settings({ type: 'save-group', values: toGroupInput(draft) });
      if (disposed) return;
      if (!reply.ok) {
        update({ error: reply.error });
        return;
      }
      if (kind === 'save-group') {
        adopt(reply.settings);
        update({ message: reply.message || t('common.done') });
      } else update({ message: reply.message || t('common.done'), error: null });
    } catch (error) {
      if (!disposed) update({ error: messageOf(error) });
    } finally {
      if (!disposed) setPending(false);
    }
  };

  return {
    store,
    refresh,
    selectGroup(groupId) {
      const state = store.getSnapshot();
      if (!state.view || state.pending || state.busy) return;
      update({ draft: draftForGroup(state.view, groupId), error: null, message: null });
    },
    newGroup() {
      const state = store.getSnapshot();
      if (!state.view || state.pending || state.busy) return;
      update({ draft: blankDraft(), error: null, message: null });
    },
    cancel() {
      const state = store.getSnapshot();
      if (!state.view || state.pending || state.busy) return;
      update({
        draft: draftForGroup(
          state.view,
          state.view.groupId || state.view.connections[0]?.groupId || '',
        ),
        error: null,
        message: null,
      });
    },
    update(patch) {
      const draft = draftOrNull();
      if (!draft || locked()) return;
      update({ draft: { ...draft, ...patch }, error: null });
    },
    updateModel(index, patch) {
      if (locked()) return;
      patchModel(index, patch);
    },
    addModel() {
      if (locked()) return;
      const draft = draftOrNull();
      if (!draft) return;
      update({ draft: { ...draft, models: [...draft.models, blankModel()] }, error: null });
    },
    removeModel(index) {
      if (locked()) return;
      const draft = draftOrNull();
      if (!draft) return;
      if (draft.models.length <= 1) {
        update({ error: t('settings.atLeastOne') });
        return;
      }
      update({
        draft: { ...draft, models: draft.models.filter((_, at) => at !== index) },
        error: null,
      });
    },
    save: () => submit('save-group'),
    test: () => submit('test'),
    async discover() {
      const state = store.getSnapshot();
      const draft = state.draft;
      if (!draft || locked()) return;
      const invalid = validateDraft(draft);
      if (invalid) {
        update({ error: t(invalid) });
        return;
      }
      setPending(true);
      update({ error: null, message: t('settings.discovering') });
      try {
        const reply = await deps.bridge.settings({
          type: 'discover',
          values: {
            ...draft.models[0]!,
            connectionId: draft.models[0]!.connectionId,
            protocol: draft.protocol,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
          },
        });
        if (disposed) return;
        if (!reply.ok) {
          update({ error: reply.error, message: null });
          return;
        }
        const catalogue = reply.discovered?.models ?? [];
        if (!catalogue.length) {
          update({ error: t('settings.discoverEmpty'), message: null });
          return;
        }
        const current = store.getSnapshot().draft!;
        const models = current.models.map((model) => {
          const found = catalogue.find((entry) => entry.id === model.model.trim());
          if (!found) return model;
          return {
            ...model,
            maxContextTokens: found.contextWindow ?? model.maxContextTokens,
            maxOutputTokens: found.maxOutputTokens ?? model.maxOutputTokens,
          };
        });
        update({ draft: { ...current, models } });
        const filled: string[] = [];
        const noWindow: string[] = [];
        const missing: string[] = [];
        draft.models.forEach((model) => {
          const id = model.model.trim();
          const found = catalogue.find((entry) => entry.id === id);
          if (!found) missing.push(id || '—');
          else if (found.contextWindow === undefined && found.maxOutputTokens === undefined)
            noWindow.push(id);
          else filled.push(id);
        });
        const parts = [
          filled.length ? t('settings.discoverFilled', { models: filled.join(', ') }) : '',
          noWindow.length ? t('settings.discoverNoWindow', { models: noWindow.join(', ') }) : '',
          missing.length
            ? t('settings.discoverMissing', {
                models: missing.join(', '),
                list: catalogue
                  .map((entry) => entry.id)
                  .slice(0, 12)
                  .join(', '),
              })
            : '',
        ].filter(Boolean);
        const text = parts.join(' ');
        if (noWindow.length || missing.length) update({ error: text, message: null });
        else update({ message: text, error: null });
      } catch (error) {
        if (!disposed) update({ error: messageOf(error), message: null });
      } finally {
        if (!disposed) setPending(false);
      }
    },
    async selectConnection(connectionId) {
      const state = store.getSnapshot();
      const view = state.view;
      // `__settings__` is the picker's settings action, never a connection to send.
      if (
        !view ||
        !connectionId ||
        connectionId === '__settings__' ||
        connectionId === view.connectionId ||
        state.pending ||
        state.busy
      )
        return;
      setPending(true);
      update({ switchStatus: t('settings.selectHint'), error: null });
      try {
        const reply = await deps.bridge.settings({ type: 'select', connectionId });
        if (disposed) return;
        if (reply.ok) adopt(reply.settings);
        else update({ switchStatus: reply.error });
      } catch (error) {
        if (!disposed) update({ switchStatus: messageOf(error) });
      } finally {
        if (!disposed) setPending(false);
      }
    },
    setBusy(busy) {
      update({ busy });
    },
    dispose() {
      disposed = true;
    },
  };
}
