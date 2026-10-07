import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ModelSettingsStore, testModelConnection } from '../apps/desktop/model-settings.ts';
import { parseSettingsCommand } from '../apps/desktop/settings-contract.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import {
  defaultUiSettings,
  parseUiSettings,
  parseUiSettingsCommand,
} from '../apps/desktop/ui-settings.ts';
import { setMainLocale } from '../apps/desktop/i18n.ts';
import { extractAttachment } from '../apps/desktop/attachment-reader.ts';
import { UiSettingsStore } from '../apps/desktop/ui-settings-store.ts';
import {
  defaultSandboxMode,
  parseSandboxSettingsCommand,
} from '../apps/desktop/sandbox-settings.ts';
import { SandboxEnvironment } from '../apps/desktop/sandbox-environment.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { PermissionSettingsStore } from '../apps/desktop/permission-settings-store.ts';
import { format, locale, onLocaleChange, setLocale, t, translate } from '../apps/desktop/i18n.ts';

// ---- merged from model-settings.test.ts ----

const key = randomBytes(32);
const cipher = {
  available: () => true,
  encrypt(text: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  },
  decrypt(bytes: Buffer) {
    const c = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    c.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString('utf8');
  },
};
test('legacy settings migrate to a named vision-capable catalog while preserving encrypted credentials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      protocol: 'openai',
      model: 'legacy',
      baseUrl: 'https://gateway.example',
      encryptedApiKey: cipher.encrypt('legacy-secret').toString('base64'),
    }),
  );
  const store = new ModelSettingsStore(file, cipher, {});
  await store.load();
  assert.equal(store.view.connections.length, 1);
  assert.equal(store.view.supportsVision, true);
  assert.equal(store.view.activeConnectionId, store.view.defaultConnectionId);
  assert.equal(store.environment().YUANTU_API_KEY, 'legacy-secret');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
  assert.doesNotMatch(JSON.stringify(store.view), /legacy-secret|encryptedApiKey/);
});
test('named connections persist independent keys, selection and vision settings across restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, cipher, {});
  const first = store.prepare({
    connectionId: '',
    name: 'Vision',
    supportsVision: true,
    model: 'vision',
    baseUrl: 'https://gateway.example',
    apiKey: 'first-private',
  });
  await store.save(first);
  assert.throws(() =>
    store.prepare({
      connectionId: '',
      name: 'Text',
      model: 'text',
      baseUrl: 'https://gateway.example',
      apiKey: '',
    }),
  );
  const second = store.prepare({
    connectionId: '',
    name: 'Text',
    supportsVision: false,
    model: 'text',
    baseUrl: 'https://gateway.example',
    apiKey: 'second-private',
  });
  await store.save(second);
  assert.notEqual(first.connectionId, second.connectionId);
  assert.equal(store.configFor(first.connectionId).apiKey, 'first-private');
  assert.equal(store.view.connectionId, second.connectionId);
  await store.select(first.connectionId);
  const reopened = new ModelSettingsStore(file, cipher, {});
  await reopened.load();
  assert.equal(reopened.view.connectionId, first.connectionId);
  assert.equal(reopened.environment().YUANTU_API_KEY, 'first-private');
  assert.equal(reopened.configFor(second.connectionId).supportsVision, false);
  assert.equal(
    reopened.prepare({
      connectionId: second.connectionId,
      name: 'Renamed',
      model: 'next-text',
      baseUrl: 'https://gateway.example',
      apiKey: '',
    }).apiKey,
    'second-private',
  );
  assert.throws(() =>
    reopened.prepare({
      connectionId: second.connectionId,
      model: 'text',
      baseUrl: 'https://other.example',
      apiKey: '',
    }),
  );
  assert.throws(() =>
    reopened.prepare({
      connectionId: 'missing',
      model: 'text',
      baseUrl: 'https://gateway.example',
      apiKey: '',
    }),
  );
  await assert.rejects(reopened.delete(first.connectionId));
  await reopened.delete(second.connectionId);
  const final = new ModelSettingsStore(file, cipher, {});
  await final.load();
  assert.equal(final.view.connections.length, 1);
  assert.doesNotMatch(JSON.stringify(final.view), /first-private|second-private|encryptedApiKey/);
  assert.doesNotMatch(await readFile(file, 'utf8'), /first-private|second-private/);
});
test('model runtime limits persist per connection and reach the Host environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-model-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, cipher, {});
  const configured = store.prepare({
    connectionId: '',
    model: 'large-model',
    baseUrl: 'https://gateway.example',
    apiKey: 'private',
    maxContextTokens: 128000,
    autoCompactTokens: 100000,
    maxOutputTokens: 8192,
    streamIdleTimeoutMs: 300000,
  });
  await store.save(configured);
  const reopened = new ModelSettingsStore(file, cipher, {});
  await reopened.load();
  assert.equal(reopened.view.maxContextTokens, 128000);
  assert.equal(reopened.environment().YUANTU_MAX_CONTEXT_TOKENS, '128000');
  assert.equal(reopened.environment().YUANTU_AUTO_COMPACT_TOKENS, '100000');
  assert.equal(reopened.environment().YUANTU_MAX_OUTPUT_TOKENS, '8192');
  assert.equal(reopened.environment().YUANTU_STREAM_IDLE_TIMEOUT_MS, '300000');
  // Both refusals, named: the pair is invalid because `autoCompactTokens` cannot be at or above the window —
  // which is what refuses `1000/2000` now that the *range* is the one `ENVIRONMENT` declares. The range test
  // below is the one that used to be served by this same pair, when the form had private bounds of its own.
  assert.throws(() =>
    parseSettingsCommand({
      type: 'save',
      values: {
        model: 'bad',
        baseUrl: 'https://gateway.example',
        apiKey: 'private',
        maxContextTokens: 1000,
        autoCompactTokens: 2000,
      },
    }),
  );
  assert.throws(() =>
    parseSettingsCommand({
      type: 'save',
      values: {
        model: 'bad',
        baseUrl: 'https://gateway.example',
        apiKey: 'private',
        maxContextTokens: 0,
      },
    }),
  );
  // And a value the form's own narrower range used to refuse is accepted, because the table accepts it and the
  // CLI always did: one declaration is the point, so the two carriers cannot disagree about the same number.
  assert.equal(
    parseSettingsCommand({
      type: 'save',
      values: {
        model: 'wide',
        baseUrl: 'https://gateway.example',
        apiKey: 'private',
        maxContextTokens: 3_000_000,
      },
    }).type,
    'save',
  );
});
test('unset optional model limits are omitted from the Host environment', () => {
  const store = new ModelSettingsStore('unused.json', cipher, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'private',
  });
  const env = store.environment();
  for (const key of [
    'YUANTU_MAX_CONTEXT_TOKENS',
    'YUANTU_AUTO_COMPACT_TOKENS',
    'YUANTU_MAX_OUTPUT_TOKENS',
    'YUANTU_STREAM_IDLE_TIMEOUT_MS',
    // A launch-environment configuration has no saved model rows, so there is no sibling map to send either.
    'YUANTU_MODEL_CAPACITIES',
  ])
    assert.equal(env[key], undefined, `${key} must not be passed as an empty number`);
});
test('environment-only model keeps runtime settings supplied by the launch environment', () => {
  const store = new ModelSettingsStore('unused.json', cipher, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'private',
    YUANTU_MAX_CONTEXT_TOKENS: '64000',
    YUANTU_AUTO_COMPACT_TOKENS: '50000',
    YUANTU_MAX_OUTPUT_TOKENS: '4096',
    YUANTU_STREAM_IDLE_TIMEOUT_MS: '180000',
  });
  assert.equal(store.view.maxContextTokens, 64000);
  assert.equal(store.view.streamIdleTimeoutMs, 180000);
  const env = store.environment();
  assert.equal(env.YUANTU_MAX_CONTEXT_TOKENS, '64000');
  assert.equal(env.YUANTU_AUTO_COMPACT_TOKENS, '50000');
  assert.equal(env.YUANTU_MAX_OUTPUT_TOKENS, '4096');
  assert.equal(env.YUANTU_STREAM_IDLE_TIMEOUT_MS, '180000');
});
test('an unusable launch-environment value is reported, and a legal one is no longer dropped', () => {
  /**
   * The bug this pins: `YUANTU_MAX_CONTEXT_TOKENS=5000000` was honoured by the CLI and *silently ignored* here,
   * because this store parsed the number itself against bounds of its own that were narrower than the ones
   * `ENVIRONMENT` declares. The user configured a window and the run was measured against nothing, with not one
   * word on screen. Both halves are asserted — the value arrives, and a value that cannot be used is said out
   * loud rather than swallowed.
   */
  const wide = new ModelSettingsStore('unused.json', cipher, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'private',
    YUANTU_MAX_CONTEXT_TOKENS: '5000000',
  });
  assert.equal(wide.view.maxContextTokens, 5_000_000);
  assert.equal(wide.view.error, null);

  const broken = new ModelSettingsStore('unused.json', cipher, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'private',
    YUANTU_MAX_CONTEXT_TOKENS: 'a very wide window',
  });
  assert.equal(broken.view.maxContextTokens, undefined, 'nothing may invent a window');
  assert.match(broken.view.error ?? '', /YUANTU_MAX_CONTEXT_TOKENS/);
  assert.match(broken.view.error ?? '', /must be a number/);

  // A misspelled name never arrives at all, and that is worth a message too — the same check the CLI and the
  // Host refuse to start on, reported rather than answered with silence. The misspelling is computed from the
  // name that is registered because `tests/environment.test.ts` fails on any unknown `YUANTU_*` literal written
  // anywhere in the project, which is exactly the gate a deliberate typo would otherwise trip.
  const misspelled = 'YUANTU_MAX_CONTEXT_TOKENS'.replace('CONTEXT', 'CONEXT');
  const typo = new ModelSettingsStore('unused.json', cipher, {
    YUANTU_MODEL: 'fixture',
    [misspelled]: '128000',
  });
  assert.match(typo.view.error ?? '', new RegExp(misspelled));
  assert.match(typo.view.error ?? '', /did you mean YUANTU_MAX_CONTEXT_TOKENS/);
});

test('catalog boundary rejects invalid identities, metadata and secret-bearing catalog fields', () => {
  assert.deepEqual(parseSettingsCommand({ type: 'select', connectionId: 'saved-1' }), {
    type: 'select',
    connectionId: 'saved-1',
  });
  for (const input of [
    { type: 'delete', connectionId: '' },
    { type: 'select', connectionId: '../secret' },
    {
      type: 'save',
      values: {
        connectionId: '',
        name: 3,
        model: 'm',
        baseUrl: 'https://example.com',
        apiKey: 'key',
      },
    },
    {
      type: 'save',
      values: {
        supportsVision: 'false',
        model: 'm',
        baseUrl: 'https://example.com',
        apiKey: 'key',
      },
    },
  ])
    assert.throws(() => parseSettingsCommand(input));
});
test('catalog views redact every connection credential and failed writes preserve the active catalog', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  let failEncryption = false;
  const store = new ModelSettingsStore(
    file,
    {
      ...cipher,
      encrypt(text) {
        if (failEncryption) throw new Error('cipher failed');
        return cipher.encrypt(text);
      },
    },
    {},
  );
  const first = store.prepare({
    connectionId: '',
    name: 'first-private connection',
    model: 'first-private model',
    baseUrl: 'https://gateway.example',
    apiKey: 'first-private',
  });
  await store.save(first);
  const second = store.prepare({
    connectionId: '',
    name: 'contains first-private',
    model: 'second-model',
    baseUrl: 'https://gateway.example',
    apiKey: 'second-private',
  });
  await store.save(second);
  assert.doesNotMatch(JSON.stringify(store.view), /first-private|second-private/);
  const captured = store.configFor(first.connectionId);
  captured.apiKey = 'changed';
  assert.equal(store.configFor(first.connectionId).apiKey, 'first-private');
  const originalBytes = await readFile(file, 'utf8');
  failEncryption = true;
  await assert.rejects(store.select(first.connectionId));
  await assert.rejects(store.delete(first.connectionId));
  await assert.rejects(store.save({ ...second, model: 'replacement' }));
  assert.equal(store.view.connectionId, second.connectionId);
  assert.equal(store.view.connections.length, 2);
  assert.equal(store.view.model, 'second-model');
  assert.equal(await readFile(file, 'utf8'), originalBytes);
});
test('model settings persist encrypted credentials, reopen without env and never expose saved key', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, cipher, {});
  await store.load();
  const config = store.prepare({
    model: 'model-a',
    baseUrl: 'https://gateway.example',
    apiKey: 'private-model-key',
  });
  await store.save(config);
  assert.doesNotMatch(await readFile(file, 'utf8'), /private-model-key/);
  assert.doesNotMatch(JSON.stringify(store.view), /private-model-key/);
  const reopened = new ModelSettingsStore(file, cipher, {});
  await reopened.load();
  assert.equal(reopened.environment().YUANTU_API_KEY, 'private-model-key');
  assert.equal(reopened.view.model, 'model-a');
  assert.equal(
    reopened.prepare({ model: 'model-b', baseUrl: 'https://gateway.example', apiKey: '' }).apiKey,
    'private-model-key',
  );
  assert.throws(
    () => reopened.prepare({ model: 'model-b', baseUrl: 'https://other.example', apiKey: '' }),
    /重新输入/,
  );
  assert.throws(
    () => reopened.prepare({ model: 'm', baseUrl: 'https://host/?key=secret', apiKey: 'x' }),
    /地址/,
  );
});
test('unavailable secret storage refuses persistence rather than writing plaintext', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, { ...cipher, available: () => false }, {});
  await store.load();
  await assert.rejects(
    store.save({ model: 'm', apiKey: 'key', baseUrl: 'https://example.com' }),
    /加密/,
  );
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('OpenAI settings survive restart and changing protocol requires a new credential', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, cipher, {});
  await store.save(
    store.prepare({
      protocol: 'openai',
      model: 'm',
      baseUrl: 'https://gateway.example',
      apiKey: 'private',
    }),
  );
  const reopened = new ModelSettingsStore(file, cipher, {});
  await reopened.load();
  assert.equal(reopened.view.protocol, 'openai');
  assert.equal(reopened.environment().YUANTU_PROTOCOL, 'openai');
  assert.throws(
    () =>
      reopened.prepare({
        protocol: 'anthropic',
        model: 'm',
        baseUrl: 'https://gateway.example',
        apiKey: '',
      }),
    /重新输入/,
  );
});
test('the discover command reads a draft the same way test does, and rejects the same shapes', () => {
  /**
   * The desktop's half of "capacity comes from the provider": the probe needs the credential that may exist
   * only in the unsaved form, so it travels as a settings command with the same draft rules as `test` — a
   * probe that could not name a model or an endpoint has nothing to ask the endpoint about.
   */
  const draft = { model: 'm', baseUrl: 'https://example.com', apiKey: 'key' };
  assert.equal(parseSettingsCommand({ type: 'discover', values: draft }).type, 'discover');
  for (const input of [
    { type: 'discover' },
    { type: 'discover', values: draft, extra: 1 },
    { type: 'discover', values: { ...draft, path: '../x' } },
    { type: 'discover', values: { ...draft, protocol: 'gemini' } },
    { type: 'discover', values: [] },
  ])
    assert.throws(() => parseSettingsCommand(input));
});
test('settings boundary validates payload and connection test uses supplied endpoint without tools', async (t) => {
  for (const input of [
    { type: 'save', values: { model: 'm', baseUrl: 3, apiKey: 's' } },
    {
      type: 'save',
      values: { model: 'm', baseUrl: 'https://example.com', apiKey: 's', path: '../x' },
    },
    { type: 'get', key: true },
  ]) {
    assert.throws(() => parseSettingsCommand(input), /配置请求/);
  }
  const url = await httpFixture(t, (body, res, headers) => {
    assert.equal(body.model, 'test-model');
    assert.equal(headers['x-api-key'], 'test-key');
    assert.equal(body.tools, undefined);
    sendFrames(res, frames('OK'));
  });
  await testModelConnection(
    { apiKey: 'test-key', model: 'test-model', baseUrl: url },
    AbortSignal.timeout(2000),
  );
});

test('one endpoint saves multiple models with one shared key and independent limits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-model-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new ModelSettingsStore(file, cipher, {});
  const command = parseSettingsCommand({
    type: 'save-group',
    values: {
      groupId: '',
      name: 'Coding gateway',
      protocol: 'openai',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'shared-private',
      models: [
        {
          connectionId: '',
          model: 'gpt-a',
          name: 'Fast',
          maxContextTokens: 256000,
          maxOutputTokens: 32000,
        },
        {
          connectionId: '',
          model: 'gpt-b',
          name: 'Deep',
          maxContextTokens: 128000,
          maxOutputTokens: 16000,
        },
      ],
    },
  });
  assert.equal(command.type, 'save-group');
  if (command.type !== 'save-group') return;
  const prepared = store.prepareGroup(command.values);
  await store.savePreparedGroup(prepared);
  assert.equal(store.view.connections.length, 2);
  assert.equal(new Set(store.view.connections.map((entry) => entry.groupId)).size, 1);
  const [first, second] = store.view.connections;
  assert.ok(first && second);
  assert.equal(first.groupName, 'Coding gateway');
  assert.equal(second.groupName, 'Coding gateway');
  assert.equal(first.maxContextTokens, 256000);
  assert.equal(second.maxContextTokens, 128000);
  assert.equal(store.configFor(first.connectionId).apiKey, 'shared-private');
  assert.equal(store.configFor(second.connectionId).apiKey, 'shared-private');
  assert.doesNotMatch(await readFile(file, 'utf8'), /shared-private/);

  const changed = store.prepareGroup({
    groupId: first.groupId,
    name: 'Renamed gateway',
    protocol: 'openai',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'rotated-private',
    activeConnectionId: second.connectionId,
    models: [
      {
        connectionId: first.connectionId,
        model: 'gpt-a',
        name: 'Fast',
        maxContextTokens: 256000,
        maxOutputTokens: 32000,
      },
      {
        connectionId: second.connectionId,
        model: 'gpt-b',
        name: 'Deep',
        maxContextTokens: 128000,
        maxOutputTokens: 16000,
      },
    ],
  });
  await store.savePreparedGroup(changed);
  const reopened = new ModelSettingsStore(file, cipher, {});
  await reopened.load();
  assert.equal(reopened.view.activeConnectionId, second.connectionId);
  assert.equal(reopened.view.groupName, 'Renamed gateway');
  assert.equal(reopened.configFor(first.connectionId).apiKey, 'rotated-private');
  assert.equal(reopened.configFor(second.connectionId).apiKey, 'rotated-private');
  /**
   * Both models' windows travel to the Host, not only the active one's.
   *
   * A window is a property of a route, and a round can be re-aimed at a sibling model: with only
   * `YUANTU_MAX_CONTEXT_TOKENS` (the active row) the other model would be measured against a number that
   * belongs to a different one — or, on an endpoint this project ships no catalogue entry for, against nothing.
   */
  assert.deepEqual(JSON.parse(reopened.environment().YUANTU_MODEL_CAPACITIES!), {
    'gpt-a': { contextWindow: 256000, maxOutputTokens: 32000 },
    'gpt-b': { contextWindow: 128000, maxOutputTokens: 16000 },
  });
  assert.throws(
    () =>
      reopened.prepareGroup({
        groupId: first.groupId,
        name: 'Renamed gateway',
        protocol: 'openai',
        baseUrl: 'https://other.example/v1',
        apiKey: '',
        models: [{ connectionId: first.connectionId, model: 'gpt-a' }],
      }),
    /API/,
  );
  assert.throws(() =>
    parseSettingsCommand({
      type: 'save-group',
      values: {
        groupId: '',
        name: '  ',
        protocol: 'openai',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'x',
        models: [{ model: 'gpt-a' }],
      },
    }),
  );
  assert.throws(() =>
    parseSettingsCommand({
      type: 'save-group',
      values: {
        groupId: '',
        protocol: 'openai',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'x',
        models: [],
      },
    }),
  );
});

test('existing v2 connections with identical credentials appear as one editable endpoint', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-v2-model-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const rows = ['first', 'second'].map((model) => ({
    connectionId: model,
    model,
    name: model,
    protocol: 'openai',
    baseUrl: 'https://gateway.example/v1',
    supportsVision: true,
    encryptedApiKey: cipher.encrypt('shared-private').toString('base64'),
  }));
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      activeConnectionId: 'second',
      defaultConnectionId: 'second',
      connections: rows,
    }),
  );
  const store = new ModelSettingsStore(file, cipher, {});
  await store.load();
  const [first, second] = store.view.connections;
  assert.ok(first && second);
  assert.equal(first.groupId, second.groupId);
  assert.equal(first.groupName, 'first');
  assert.equal(second.groupName, 'first');
  const prepared = store.prepareGroup({
    groupId: first.groupId,
    name: 'Migrated gateway',
    protocol: 'openai',
    baseUrl: first.baseUrl,
    apiKey: '',
    models: [
      { connectionId: first.connectionId, model: first.model },
      { connectionId: second.connectionId, model: second.model },
    ],
  });
  await store.savePreparedGroup(prepared);
  assert.equal(store.view.activeConnectionId, second.connectionId);
  assert.equal(store.view.groupName, 'Migrated gateway');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).connections[0].groupId, first.groupId);
});

test('model settings accept the 1M context and 256K output limits', () => {
  const command = parseSettingsCommand({
    type: 'save',
    values: {
      model: 'large-model',
      baseUrl: 'https://gateway.example',
      apiKey: 'private',
      maxContextTokens: 1000000,
      maxOutputTokens: 256000,
    },
  });
  assert.equal(command.type, 'save');
  if (command.type !== 'save') throw new Error('Expected a save command');
  assert.equal(command.values.maxContextTokens, 1000000);
  assert.equal(command.values.maxOutputTokens, 256000);
});

// ---- merged from ui-settings.test.ts ----

test('UI settings contract accepts only supported language, appearance and font size', () => {
  assert.deepEqual(parseUiSettingsCommand({ type: 'get' }), { type: 'get' });
  assert.deepEqual(
    parseUiSettingsCommand({
      type: 'save',
      settings: { language: 'en-US', appearance: 'dark', fontSize: 'large' },
    }),
    {
      type: 'save',
      settings: { language: 'en-US', appearance: 'dark', fontSize: 'large' },
    },
  );
  assert.throws(
    () =>
      parseUiSettingsCommand({
        type: 'save',
        settings: { language: 'fr', appearance: 'dark', fontSize: 'large' },
      }),
    /通用设置/,
  );
  assert.throws(
    () =>
      parseUiSettingsCommand({
        type: 'save',
        settings: {
          language: 'zh-CN',
          appearance: 'system',
          fontSize: 'medium',
          path: 'outside',
        },
      }),
    /通用设置/,
  );
});

test('main-process text follows the language the interface is in, not the default', () => {
  /**
   * What the language gate cannot see, asserted where it can be.
   *
   * The desktop's own gate walks the rendered document, so a message the *main* process produces is invisible to
   * it: a validation error or a failure dialog is written here, in a process with no DOM, and only then handed to
   * a page that may already be in another language. Both processes read the same dictionary now, and this is that
   * claim made checkable — the same call answers in Chinese and then in English.
   *
   * `parseUiSettings` is the smallest message to ask, and the settings page's own errors travel the same path
   * through `mainText`.
   */
  setMainLocale('zh-CN');
  assert.throws(() => parseUiSettings({ language: 'fr-FR' }), /无效的通用设置/);
  setMainLocale('en-US');
  assert.throws(() => parseUiSettings({ language: 'fr-FR' }), /Invalid interface settings/);
  // Left as it was found: the module's language is process state, and the tests after this one expect the default.
  setMainLocale('zh-CN');
});

test('the attachment reader answers in the same language, from the same dictionary', async () => {
  /**
   * A second module, to show this is the dictionary rather than one file's local habit. It matters more here than
   * it looks: the read itself happens in a worker thread, which has its own copy of every module, so the language
   * has to travel with the work — `main.ts` puts it in `workerData` and `attachment-worker.ts` sets it before
   * reading anything. What this test can reach is the reader, in both languages, in this process.
   */
  setMainLocale('zh-CN');
  await assert.rejects(extractAttachment('empty.txt', Buffer.alloc(0)), /文件为空/);
  setMainLocale('en-US');
  await assert.rejects(extractAttachment('empty.txt', Buffer.alloc(0)), /file is empty/i);
  setMainLocale('zh-CN');
});

test('UI settings persist across reload and malformed files fall back to defaults', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-ui-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'ui-settings.json');
  const store = new UiSettingsStore(file);
  await store.load();
  assert.deepEqual(store.view, defaultUiSettings());
  await store.save({ language: 'en-US', appearance: 'dark', fontSize: 'large' });
  const reopened = new UiSettingsStore(file);
  await reopened.load();
  assert.deepEqual(reopened.view, {
    language: 'en-US',
    appearance: 'dark',
    fontSize: 'large',
  });
  assert.match(await readFile(file, 'utf8'), /"appearance": "dark"/);
  await writeFile(file, '{"appearance":"invalid"}');
  const recovered = new UiSettingsStore(file);
  await recovered.load();
  assert.deepEqual(recovered.view, defaultUiSettings());
});

// ---- merged from sandbox-settings.test.ts ----

test('desktop sandbox host selection requires explicit acknowledgement', () => {
  assert.throws(() => parseSandboxSettingsCommand({ type: 'set', mode: 'host' }), /confirm/i);
  assert.throws(() => parseSandboxSettingsCommand({ type: 'set', mode: 'docker', extra: true }));
  assert.throws(
    () => parseSandboxSettingsCommand({ type: 'get' }),
    /sandbox settings request/i,
    'the chip writes presets; a bare read is not a command this parser has',
  );
  assert.deepEqual(
    parseSandboxSettingsCommand({ type: 'set', mode: 'host', acknowledgeHost: true }),
    { type: 'set', mode: 'host', acknowledgeHost: true },
  );
});
test('the launch environment names the mode a new session starts in, and nothing else', () => {
  assert.equal(defaultSandboxMode({}), 'sbx', 'a desktop that was told nothing starts confined');
  assert.equal(defaultSandboxMode({ YUANTU_SANDBOX: 'host' }), 'host');
  assert.equal(defaultSandboxMode({ YUANTU_SANDBOX: 'windows' }), 'windows');
  assert.throws(() => defaultSandboxMode({ YUANTU_SANDBOX: 'other' }), /YUANTU_SANDBOX/);
  /**
   * The environment is a default, not a lock: the desktop used to refuse every write while it was set, which
   * made the chip unusable for exactly the operators who had stated a preference. `SandboxEnvironment` still
   * reports it — as the mode a *new* session begins in.
   */
  const environment = new SandboxEnvironment({ YUANTU_SANDBOX: 'host' });
  assert.equal(environment.defaultMode, 'host');
  assert.equal(environment.environment().YUANTU_SANDBOX, 'host');
  assert.equal(new SandboxEnvironment({}).environment().YUANTU_SANDBOX, 'sbx');
});
test('a backend nobody has probed reads as unknown rather than as usable', async () => {
  const environment = new SandboxEnvironment({ YUANTU_SANDBOX: 'host' });
  assert.equal(environment.known('docker'), false, 'nobody has asked about docker');
  assert.equal(environment.cached('docker'), null);
  assert.equal(await environment.probe('host'), null, 'the host backend always can');
  assert.equal(environment.known('host'), true, 'and now somebody has asked');
  assert.equal(
    environment.cached('host'),
    null,
    '"it can" is reported as no problem, not as an answer',
  );
});

// ---- merged from permission-settings.test.ts ----

test('permission modes map to fixed policies', () => {
  assert.deepEqual(permissionPolicyForMode('read-only'), {
    version: 1,
    rules: [
      { effect: 'deny', kind: 'write' },
      { effect: 'deny', kind: 'command' },
      { effect: 'deny', kind: 'external' },
    ],
  });
  assert.deepEqual(permissionPolicyForMode('ask'), { version: 1, rules: [] });
  assert.deepEqual(permissionPolicyForMode('approve'), {
    version: 1,
    rules: [
      { effect: 'allow', kind: 'write' },
      { effect: 'ask', kind: 'command' },
      { effect: 'ask', kind: 'external' },
    ],
  });
  assert.deepEqual(permissionPolicyForMode('full-access'), {
    version: 1,
    rules: [
      { effect: 'allow', kind: 'write' },
      { effect: 'allow', kind: 'command' },
      { effect: 'allow', kind: 'external' },
    ],
  });
});

test('permission mode defaults to ask and persists only fixed policies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-permission-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'permission-policy.json');
  const store = new PermissionSettingsStore(file);
  await store.load();
  assert.equal(store.view, 'ask');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), permissionPolicyForMode('ask'));

  await store.save('full-access');
  const reopened = new PermissionSettingsStore(file);
  await reopened.load();
  assert.equal(reopened.view, 'full-access');
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')),
    permissionPolicyForMode('full-access'),
  );

  await writeFile(file, JSON.stringify({ version: 1, rules: [] }));
  const recovered = new PermissionSettingsStore(file);
  await recovered.load();
  assert.equal(recovered.view, 'ask');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), permissionPolicyForMode('ask'));
});

// ---- merged from sandbox-availability.test.ts ----

test('a desktop with no usable sbx reports why, without changing where sessions start', async () => {
  /**
   * The probe is an operator's answer, not a policy: an sbx that cannot run here is reported, and the mode a
   * new session starts in stays `sbx` — the fail-closed default. The old store *did* have a fail-closed path
   * (it rewrote a file); there is no file to rewrite now, which is the point of the mode being per session.
   */
  const environment = new SandboxEnvironment({ PATH: '', Path: '' });
  assert.equal(environment.defaultMode, 'sbx');
  assert.match((await environment.probe('sbx')) ?? '', /sbx.*unavailable/i);
  assert.match(environment.cached('sbx') ?? '', /sbx.*unavailable/i);
});

// ---- merged from i18n.test.ts ----

test('desktop locale formats and translates zh-CN and en-US resources', () => {
  assert.equal(format('Hello {name} {missing}', { name: 'Agent' }), 'Hello Agent {missing}');
  assert.equal(translate('background.title', 'zh-CN'), '后台任务');
  assert.equal(translate('background.title', 'en-US'), 'Background tasks');
  assert.equal(translate('ui.removeImage', 'en-US', { name: 'shot.png' }), 'Remove shot.png');
  assert.equal(translate('unknown.key', 'en-US'), 'unknown.key');
});

test('desktop locale updates current language and notifies listeners', () => {
  setLocale('zh-CN');
  let changes = 0;
  const unsubscribe = onLocaleChange(() => changes++);
  setLocale('en-US');
  assert.equal(locale(), 'en-US');
  assert.equal(t('background.stop'), 'Stop task');
  assert.equal(changes, 1);
  unsubscribe();
  setLocale('zh-CN');
  assert.equal(t('background.stop'), '停止任务');
  assert.equal(changes, 1);
});
