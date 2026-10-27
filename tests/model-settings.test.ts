import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ANTHROPIC_URL,
  DEFAULT_OPENAI_URL,
  blankDraft,
  draftForGroup,
  environmentModelLabel,
  groupConnections,
  limitsFor,
  modelFromConnection,
  pickerOptions,
  protocolDefaultUrl,
  toGroupInput,
  validateDraft,
  type ModelDraft,
} from '../apps/desktop/ui/settings/model-settings-model.ts';
import type { ModelConnectionView, ModelSettingsView } from '../apps/desktop/settings-contract.ts';
import { connectModelSelection } from '../apps/desktop/ui/settings/model-selection.ts';
import { modelPicker } from '../apps/desktop/ui/settings/model-picker-state.ts';

function connection(overrides: Partial<ModelConnectionView> = {}): ModelConnectionView {
  return {
    groupId: 'group-a',
    groupName: 'Gateway',
    connectionId: 'a-1',
    name: 'model-a',
    supportsVision: true,
    protocol: 'openai',
    baseUrl: 'https://gateway.test',
    model: 'model-a',
    hasKey: true,
    ...overrides,
  };
}

function view(overrides: Partial<ModelSettingsView> = {}): ModelSettingsView {
  return {
    connectionId: 'a-1',
    groupId: 'group-a',
    groupName: 'Gateway',
    name: 'model-a',
    supportsVision: true,
    connections: [connection()],
    activeConnectionId: 'a-1',
    defaultConnectionId: 'a-1',
    protocol: 'openai',
    baseUrl: 'https://gateway.test',
    model: 'model-a',
    hasKey: true,
    source: 'saved',
    encryptionAvailable: true,
    error: null,
    ...overrides,
  };
}

test('the environment reading is labelled per language and only for environment sources', () => {
  assert.equal(
    environmentModelLabel({ source: 'environment', model: 'env-model' }, false),
    'env-model（环境变量）',
  );
  assert.equal(
    environmentModelLabel({ source: 'environment', model: 'env-model' }, true),
    'env-model (environment)',
  );
  assert.equal(environmentModelLabel({ source: 'saved', model: 'env-model' }, false), null);
  assert.equal(environmentModelLabel({ source: 'environment', model: '' }, false), null);
});

test('connections are grouped in host order', () => {
  const grouped = groupConnections({
    connections: [
      connection({ connectionId: 'a-1', groupId: 'group-a', model: 'first' }),
      connection({ connectionId: 'b-1', groupId: 'group-b', groupName: 'Other', model: 'second' }),
      connection({ connectionId: 'a-2', groupId: 'group-a', model: 'third' }),
    ],
  });
  assert.deepEqual([...grouped.keys()], ['group-a', 'group-b']);
  assert.deepEqual(
    grouped.get('group-a')?.map((entry) => entry.connectionId),
    ['a-1', 'a-2'],
  );
});

test('a saved group is drafted from its first connection and keeps every row', () => {
  const draft = draftForGroup(
    view({
      connections: [
        connection({ connectionId: 'a-1', model: 'first', maxContextTokens: 8000 }),
        connection({ connectionId: 'a-2', model: 'second' }),
      ],
    }),
    'group-a',
  );
  assert.equal(draft.groupId, 'group-a');
  assert.equal(draft.name, 'Gateway');
  assert.equal(draft.baseUrl, 'https://gateway.test');
  assert.equal(draft.models.length, 2);
  assert.equal(draft.models[0]?.maxContextTokens, 8000);
  assert.equal(draft.models[1]?.model, 'second');
  assert.equal(draft.apiKey, '');
});

test('an unknown group starts blank with OpenAI defaults', () => {
  const draft = draftForGroup(view(), 'missing');
  assert.equal(draft.groupId, '');
  assert.equal(draft.name, '');
  assert.equal(draft.protocol, 'openai');
  assert.equal(draft.baseUrl, DEFAULT_OPENAI_URL);
  assert.equal(draft.models.length, 1);
  assert.equal(draft.models[0]?.model, '');
});

test('the environment reading seeds the editor when no group is saved', () => {
  const draft = draftForGroup(
    view({
      connections: [],
      groupId: '',
      source: 'environment',
      model: 'env-model',
      baseUrl: 'https://env.test',
      protocol: 'anthropic',
    }),
    '',
  );
  assert.equal(draft.models.length, 1);
  assert.equal(draft.models[0]?.model, 'env-model');
  assert.equal(draft.baseUrl, 'https://env.test');
  assert.equal(draft.protocol, 'anthropic');
});

test('the payload normalises empty name and null limits', () => {
  const draft: ModelDraft = {
    ...blankDraft(),
    name: 'Gateway',
    apiKey: 'secret',
    models: [
      {
        connectionId: '',
        model: 'model-a',
        name: '',
        supportsVision: false,
        maxContextTokens: 8000,
        maxOutputTokens: null,
        autoCompactTokens: null,
        streamIdleTimeoutMs: null,
      },
    ],
  };
  const input = toGroupInput(draft);
  assert.equal(input.models[0]?.name, 'model-a');
  assert.equal(input.models[0]?.maxOutputTokens, null);
  assert.equal(input.models[0]?.supportsVision, false);
  assert.equal(input.apiKey, 'secret');
});

test('duplicate model ids and an empty list are refused with dictionary keys', () => {
  const draft = blankDraft();
  assert.equal(validateDraft(draft), null);
  assert.equal(validateDraft({ ...draft, models: [] }), 'settings.atLeastOne');
  assert.equal(
    validateDraft({
      ...draft,
      models: [modelFromConnection({ model: 'same' }), modelFromConnection({ model: ' same ' })],
    }),
    'settings.duplicateModel',
  );
});

test('picker options never include the settings action and keep the environment reading selectable-looking', () => {
  const saved = pickerOptions(view(), { noModel: 'no model', environment: false });
  assert.deepEqual(saved, [{ value: 'a-1', label: 'model-a' }]);
  const environment = pickerOptions(
    view({ connections: [], source: 'environment', model: 'env-model' }),
    { noModel: 'no model', environment: false },
  );
  assert.deepEqual(environment, [{ value: '', label: 'env-model（环境变量）' }]);
  const empty = pickerOptions(view({ connections: [], source: 'empty', model: '' }), {
    noModel: 'no model',
    environment: false,
  });
  assert.deepEqual(empty, [{ value: '', label: 'no model' }]);
});

test('limits come from the host contract, not a second pair typed into the form', () => {
  const context = limitsFor('maxContextTokens');
  assert.ok(context.min >= 0);
  assert.ok(context.max > context.min);
  assert.deepEqual(limitsFor('streamIdleTimeoutMs'), limitsFor('streamIdleTimeoutMs'));
});

test('a protocol change suggests the matching default URL', () => {
  assert.equal(protocolDefaultUrl('anthropic'), DEFAULT_ANTHROPIC_URL);
  assert.equal(protocolDefaultUrl('openai'), DEFAULT_OPENAI_URL);
  assert.equal(protocolDefaultUrl('openai-responses'), DEFAULT_OPENAI_URL);
});

/**
 * The panel's state machine over a scripted bridge.
 *
 * The interesting contracts are the guards: a sentinel is not a connection, a locked form sends nothing, a refused
 * save keeps the draft so the operator can fix it, and discovery only fills the limits the catalogue actually
 * answered. None of that needs a window.
 */
import { setLocale, t } from '../apps/desktop/i18n.ts';
import {
  createModelSettingsController,
  type ModelSettingsController,
} from '../apps/desktop/ui/settings/model-settings-model.ts';
import type { SettingsCommand, SettingsReply } from '../apps/desktop/settings-contract.ts';

setLocale('zh-CN');

function savedView(overrides: Partial<ModelSettingsView> = {}): ModelSettingsView {
  return {
    connectionId: 'a-1',
    groupId: 'group-a',
    groupName: 'Gateway',
    name: 'model-a',
    supportsVision: true,
    connections: [connection({ connectionId: 'a-1', model: 'model-a' })],
    activeConnectionId: 'a-1',
    defaultConnectionId: 'a-1',
    protocol: 'openai',
    baseUrl: 'https://gateway.test',
    model: 'model-a',
    hasKey: true,
    source: 'saved',
    encryptionAvailable: true,
    error: null,
    ...overrides,
  };
}

function scripted(handler?: (command: SettingsCommand) => Promise<SettingsReply>) {
  const commands: SettingsCommand[] = [];
  const controller: ModelSettingsController = createModelSettingsController({
    bridge: {
      settings: (async (command: SettingsCommand) => {
        commands.push(command);
        if (handler) return handler(command);
        if (command.type === 'save-group' || command.type === 'select')
          return { ok: true, settings: savedView() };
        if (command.type === 'test') return { ok: true, settings: savedView(), message: 'host ok' };
        if (command.type === 'discover')
          return {
            ok: true,
            settings: savedView(),
            discovered: {
              endpoint: 'https://gateway.test',
              models: [{ id: 'model-a', contextWindow: 32000 }],
            },
          };
        return { ok: true, settings: savedView() };
      }) as never,
    },
  });
  return { controller, commands };
}

test('refresh adopts the view and its first group', async () => {
  const { controller } = scripted();
  await controller.refresh();
  const state = controller.store.getSnapshot();
  assert.equal(state.view?.connectionId, 'a-1');
  assert.equal(state.draft?.groupId, 'group-a');
  assert.equal(state.draft?.models[0]?.model, 'model-a');
  assert.equal(state.pending, false);
});

test('a duplicate model id is refused before any command is sent', async () => {
  const { controller, commands } = scripted();
  await controller.refresh();
  controller.addModel();
  controller.updateModel(1, { model: 'model-a' });
  await controller.save();
  assert.equal(controller.store.getSnapshot().error, t('settings.duplicateModel'));
  assert.deepEqual(
    commands.filter((command) => command.type === 'save-group'),
    [],
  );
});

test('a saved group adopts the answer and says it is done', async () => {
  const { controller, commands } = scripted();
  await controller.refresh();
  await controller.save();
  assert.equal(controller.store.getSnapshot().error, null);
  assert.ok(controller.store.getSnapshot().message);
  assert.equal(commands.filter((command) => command.type === 'save-group').length, 1);
});

test('a refused save keeps the draft so it can be fixed', async () => {
  const { controller } = scripted((command) =>
    command.type === 'save-group'
      ? Promise.resolve({ ok: false, error: 'encryption unavailable' })
      : Promise.resolve({ ok: true, settings: savedView() }),
  );
  await controller.refresh();
  controller.updateModel(0, { model: 'edited-model' });
  await controller.save();
  const state = controller.store.getSnapshot();
  assert.equal(state.error, 'encryption unavailable');
  assert.equal(state.draft?.models[0]?.model, 'edited-model');
});

test('the form is locked while a run is streaming and sends nothing', async () => {
  const { controller, commands } = scripted();
  await controller.refresh();
  controller.setBusy(true);
  controller.updateModel(0, { model: 'while-busy' });
  await controller.save();
  assert.equal(controller.store.getSnapshot().draft?.models[0]?.model, 'model-a');
  assert.deepEqual(
    commands.filter((command) => command.type === 'save-group'),
    [],
  );
});

test('the settings sentinel and the current connection are never selected', async () => {
  const { controller, commands } = scripted();
  await controller.refresh();
  await controller.selectConnection('__settings__');
  await controller.selectConnection('a-1');
  await controller.selectConnection('');
  assert.deepEqual(
    commands.filter((command) => command.type === 'select'),
    [],
  );
  await controller.selectConnection('b-1');
  assert.equal(commands.filter((command) => command.type === 'select').length, 1);
});

test('a refused switch reports why and leaves the view alone', async () => {
  const { controller } = scripted((command) =>
    command.type === 'select'
      ? Promise.resolve({ ok: false, error: 'busy' })
      : Promise.resolve({ ok: true, settings: savedView() }),
  );
  await controller.refresh();
  await controller.selectConnection('b-1');
  assert.equal(controller.store.getSnapshot().switchStatus, 'busy');
  assert.equal(controller.store.getSnapshot().view?.connectionId, 'a-1');
});

test('a pending model selection has no switching copy and still reports failures', async () => {
  let settle!: (reply: SettingsReply) => void;
  const { controller } = scripted((command) =>
    command.type === 'select'
      ? new Promise((resolve) => {
          settle = resolve;
        })
      : Promise.resolve({ ok: true, settings: savedView() }),
  );
  await controller.refresh();
  const choosing = controller.selectConnection('b-1');
  assert.equal(controller.store.getSnapshot().pending, true);
  assert.equal(controller.store.getSnapshot().switchStatus, null);
  settle({ ok: false, error: 'connection removed' });
  await choosing;
  assert.equal(controller.store.getSnapshot().switchStatus, 'connection removed');
});

test('the picker refreshes when the connection changes while the chat and model label stay the same', async (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const element = new EventTarget();
  let view = savedView({ model: 'same-model', connectionId: 'a-1' });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementById: () => element },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { yuantu: { settings: async () => ({ ok: true, settings: view }) } },
  });
  const controller = connectModelSelection(
    () => false,
    () => {},
  );
  t.after(() => {
    controller.dispose();
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  Reflect.apply(controller.updateSession, controller, ['chat', 'same-model', 'a-1']);
  await Promise.resolve();
  assert.equal(modelPicker.getSnapshot().view?.connectionId, 'a-1');
  view = savedView({ model: 'same-model', connectionId: 'b-1' });
  Reflect.apply(controller.updateSession, controller, ['chat', 'same-model', 'b-1']);
  await Promise.resolve();
  assert.equal(modelPicker.getSnapshot().view?.connectionId, 'b-1');
});

test('discovery fills only the limits the catalogue answered and names the rest', async () => {
  const { controller } = scripted((command) =>
    command.type === 'discover'
      ? Promise.resolve({
          ok: true,
          settings: savedView(),
          discovered: {
            endpoint: 'https://gateway.test',
            models: [{ id: 'model-a', contextWindow: 32000 }, { id: 'other-model' }],
          },
        })
      : Promise.resolve({ ok: true, settings: savedView() }),
  );
  await controller.refresh();
  controller.addModel();
  controller.updateModel(1, { model: 'unknown-model' });
  await controller.discover();
  const state = controller.store.getSnapshot();
  assert.equal(state.draft?.models[0]?.maxContextTokens, 32000);
  assert.match(state.error ?? '', /unknown-model/);
});

test('the last row cannot be removed', async () => {
  const { controller } = scripted();
  await controller.refresh();
  controller.removeModel(0);
  assert.equal(controller.store.getSnapshot().error, t('settings.atLeastOne'));
  assert.equal(controller.store.getSnapshot().draft?.models.length, 1);
});

test('cancel restores the persisted group and clears messages', async () => {
  const { controller } = scripted();
  await controller.refresh();
  controller.updateModel(0, { model: 'unsaved' });
  controller.cancel();
  const state = controller.store.getSnapshot();
  assert.equal(state.draft?.models[0]?.model, 'model-a');
  assert.equal(state.error, null);
  assert.equal(state.message, null);
});
