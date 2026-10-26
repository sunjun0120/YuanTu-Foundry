import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeneralSettingsController,
  type GeneralSettingsController,
} from '../apps/desktop/ui/settings/settings-model.ts';
import {
  defaultUiSettings,
  type UiSettings,
  type UiSettingsReply,
} from '../apps/desktop/ui-settings.ts';

/**
 * The general settings form's save queue, without a DOM.
 *
 * The old test drove `setupGeneralSettings` through a hand-written fake document, which covered the refusal path
 * but not the one that actually hung the window: a **rejected** `uiSettings` promise. An `await` that threw before
 * the in-flight flag was released swallowed every later change, and no smoke could see it because the smoke drives
 * the built bundle. The controller has no DOM and no build step between it and this test.
 */
type Reply = (command: { type: 'get' | 'save'; settings?: UiSettings }) => Promise<UiSettingsReply>;

function settings(overrides: Partial<UiSettings> = {}): UiSettings {
  return { ...defaultUiSettings(), ...overrides };
}

function fixture(reply?: Reply) {
  const calls: UiSettings[] = [];
  const applied: UiSettings[] = [];
  const answer: Reply =
    reply ??
    (async (command) => ({ ok: true, kind: 'settings', settings: command.settings ?? settings() }));
  const controller: GeneralSettingsController = createGeneralSettingsController({
    bridge: {
      uiSettings: (async (command: { type: 'get' | 'save'; settings?: UiSettings }) => {
        if (command.type === 'save' && command.settings) calls.push(command.settings);
        return answer(command);
      }) as never,
    },
    apply: (value) => applied.push(value),
  });
  return { calls, controller, applied };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a stored read fills both draft and persisted and applies it', async () => {
  const stored = settings({ language: 'en-US', appearance: 'dark' });
  const { calls, controller, applied } = fixture(async () => ({
    ok: true,
    kind: 'settings',
    settings: stored,
  }));
  await controller.load();
  const state = controller.store.getSnapshot();
  assert.deepEqual(state.draft, stored);
  assert.deepEqual(state.persisted, stored);
  assert.deepEqual(applied.at(-1), stored);
  assert.equal(state.error, null);
  assert.equal(state.loaded, true);
  assert.equal(calls.length, 0);
});

test('a change is applied at once and saved once', async () => {
  const { calls, controller, applied } = fixture();
  await controller.load();
  controller.change({ appearance: 'dark' });
  await flush();
  const state = controller.store.getSnapshot();
  assert.deepEqual(state.draft, settings({ appearance: 'dark' }));
  assert.deepEqual(applied.at(-1), settings({ appearance: 'dark' }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], settings({ appearance: 'dark' }));
  assert.equal(state.saving, false);
});

test('a change made while a save is in flight is sent once, with the newest values', async () => {
  const releases: Array<(reply: UiSettingsReply) => void> = [];
  const { calls, controller } = fixture((command) => {
    if (command.type === 'get')
      return Promise.resolve({ ok: true, kind: 'settings', settings: settings() });
    return new Promise<UiSettingsReply>((resolve) => releases.push(resolve));
  });
  await controller.load();
  controller.change({ appearance: 'dark' });
  await flush();
  controller.change({ fontSize: 'large' });
  await flush();
  assert.equal(controller.store.getSnapshot().saving, true);
  assert.equal(controller.store.getSnapshot().draft.fontSize, 'large');
  releases[0]?.({ ok: true, kind: 'settings', settings: settings({ appearance: 'dark' }) });
  await flush();
  await flush();
  // The second save is the queued change; answer it with the newest values.
  assert.equal(releases.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.fontSize, 'large');
  releases[1]?.({
    ok: true,
    kind: 'settings',
    settings: settings({ appearance: 'dark', fontSize: 'large' }),
  });
  await flush();
  await flush();
  const state = controller.store.getSnapshot();
  // The stored copy moved forward but the newer draft stayed on screen.
  assert.equal(state.persisted.appearance, 'dark');
  assert.equal(state.persisted.fontSize, 'large');
  assert.equal(state.draft.fontSize, 'large');
  assert.equal(state.saving, false);
});

test('a refused save rolls the form back to persisted and reports the reason', async () => {
  let refusals = 1;
  const { controller } = fixture((command) => {
    if (command.type === 'get')
      return Promise.resolve({ ok: true, kind: 'settings', settings: settings() });
    if (refusals > 0) {
      refusals -= 1;
      return Promise.resolve({ ok: false, error: 'host refused' });
    }
    return Promise.resolve({
      ok: true,
      kind: 'settings',
      settings: command.settings ?? settings(),
    });
  });
  await controller.load();
  controller.change({ appearance: 'dark' });
  await flush();
  await flush();
  const state = controller.store.getSnapshot();
  assert.equal(state.error, 'host refused');
  assert.deepEqual(state.draft, settings());
  assert.equal(state.saving, false);
  // A later change is not blocked by the failure.
  controller.change({ fontSize: 'large' });
  await flush();
  await flush();
  const after = controller.store.getSnapshot();
  assert.equal(after.error, null);
  assert.equal(after.draft.fontSize, 'large');
});

test('a rejected save releases the in-flight flag and can be retried', async () => {
  let rejects = 1;
  const { controller } = fixture((command) => {
    if (command.type === 'get')
      return Promise.resolve({ ok: true, kind: 'settings', settings: settings() });
    if (rejects > 0) {
      rejects -= 1;
      return Promise.reject(new Error('channel closed'));
    }
    return Promise.resolve({
      ok: true,
      kind: 'settings',
      settings: command.settings ?? settings(),
    });
  });
  await controller.load();
  controller.change({ appearance: 'dark' });
  await flush();
  await flush();
  assert.equal(controller.store.getSnapshot().error, 'channel closed');
  assert.equal(controller.store.getSnapshot().saving, false);
  // The defect this test exists for: the next change must still be sent.
  controller.change({ fontSize: 'large' });
  await flush();
  await flush();
  assert.equal(controller.store.getSnapshot().error, null);
  assert.equal(controller.store.getSnapshot().persisted.fontSize, 'large');
  assert.equal(controller.store.getSnapshot().saving, false);
});

test('a change that matches what is stored sends nothing', async () => {
  const { calls, controller } = fixture();
  await controller.load();
  controller.change({ appearance: 'system' });
  await flush();
  assert.equal(calls.length, 0);
});

test('a failed read reports the reason and leaves the defaults in place', async () => {
  const { controller } = fixture(() => Promise.resolve({ ok: false, error: 'no settings file' }));
  await controller.load();
  const state = controller.store.getSnapshot();
  assert.equal(state.error, 'no settings file');
  assert.equal(state.loaded, true);
  assert.deepEqual(state.draft, defaultUiSettings());
});

test('disposing stops a late reply from changing anything', async () => {
  const releases: Array<(reply: UiSettingsReply) => void> = [];
  const { controller } = fixture((command) => {
    if (command.type === 'get')
      return Promise.resolve({ ok: true, kind: 'settings', settings: settings() });
    return new Promise<UiSettingsReply>((resolve) => releases.push(resolve));
  });
  await controller.load();
  controller.change({ appearance: 'light' });
  controller.dispose();
  releases[0]?.({ ok: true, kind: 'settings', settings: settings() });
  await flush();
  assert.deepEqual(controller.store.getSnapshot().draft, settings({ appearance: 'light' }));
});
