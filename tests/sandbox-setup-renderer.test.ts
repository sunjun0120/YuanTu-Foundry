import test from 'node:test';
import assert from 'node:assert/strict';
import { runStatusText } from '../apps/desktop/renderer-status.ts';
import { setLocale, t, translate } from '../apps/desktop/i18n.ts';
import type {
  SandboxSetupCommand,
  SandboxSetupReply,
  SandboxSetupView,
} from '../apps/desktop/sandbox-setup.ts';
import type { PermissionPresetCommand } from '../apps/desktop/permission-presets.ts';
import {
  commandsNeedSandboxAccounts,
  createSandboxSetupController,
  sandboxPromptFeedback,
  sandboxPromptTitleKey,
  sandboxPromptVisible,
  type SandboxSetupController,
} from '../apps/desktop/ui/sandbox/sandbox-setup-model.ts';

/**
 * The Windows sandbox-account prompt, without a DOM.
 *
 * The legacy test drove `setupSandboxInitialization` through a hand-written fake document, so what it verified was
 * mostly that the module wrote to the right element. The controller keeps the four independent facts (backend state,
 * whether this session needs accounts, dismissal, in-flight request) in one place and the test asks about them
 * directly: moving back onto the sandbox re-offers the prompt, a damaged backend is diagnosed once, a rejected
 * initialize releases the controls.
 */
setLocale('zh-CN');

const ready: SandboxSetupView = {
  supported: true,
  ready: true,
  installed: true,
  reason: null,
  state: 'ready',
};
const uninitialized: SandboxSetupView = {
  supported: true,
  ready: false,
  installed: false,
  reason: null,
  state: 'uninitialized',
};
const damaged: SandboxSetupView = {
  supported: true,
  ready: false,
  installed: true,
  reason: null,
  state: 'damaged',
  problems: ['accountsMissing'],
  details: ['detail one'],
};

function fixture(options: {
  reply?: (command: SandboxSetupCommand) => Promise<SandboxSetupReply>;
  presets?: (command: PermissionPresetCommand) => Promise<unknown>;
  confirm?: () => boolean;
  api?: boolean;
}) {
  const commands: SandboxSetupCommand[] = [];
  const presets: PermissionPresetCommand[] = [];
  const controller: SandboxSetupController = createSandboxSetupController({
    api:
      options.api === false
        ? undefined
        : async (command) => {
            commands.push(command);
            return options.reply ? options.reply(command) : { ok: true, view: ready };
          },
    presets: async (command) => {
      presets.push(command);
      return options.presets ? options.presets(command) : { ok: true };
    },
    confirm: options.confirm ?? (() => true),
  });
  return { controller, commands, presets };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('only a native preset with uninitialized accounts needs the setup', () => {
  assert.equal(commandsNeedSandboxAccounts({ mode: 'native', state: 'uninitialized' }), true);
  assert.equal(commandsNeedSandboxAccounts({ mode: 'native', state: 'ready' }), false);
  assert.equal(commandsNeedSandboxAccounts({ mode: 'windows', state: 'uninitialized' }), false);
  assert.equal(commandsNeedSandboxAccounts({ mode: 'host', state: 'uninitialized' }), false);
  assert.equal(commandsNeedSandboxAccounts({ mode: 'windows-account', state: 'damaged' }), true);
  assert.equal(commandsNeedSandboxAccounts({ mode: undefined, state: 'uninitialized' }), true);
});

test('ready accounts draw nothing: one status read, no prompt', async () => {
  const { controller, commands } = fixture({ reply: async () => ({ ok: true, view: ready }) });
  await controller.start();
  assert.deepEqual(commands, [{ type: 'status' }]);
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), false);
});

test('uninitialized accounts are offered above the composer', async () => {
  const { controller, commands } = fixture({
    reply: async () => ({ ok: true, view: uninitialized }),
  });
  await controller.start();
  const state = controller.store.getSnapshot();
  assert.equal(sandboxPromptVisible(state), true);
  assert.equal(sandboxPromptTitleKey(state.view?.state), 'sandboxSetup.prompt.title');
  await controller.request({ type: 'initialize', acknowledge: true });
  assert.deepEqual(commands[1], { type: 'initialize', acknowledge: true });
});

test('commands are announced as unavailable while the rest of the application keeps working', async () => {
  const { controller } = fixture({ reply: async () => ({ ok: true, view: uninitialized }) });
  await controller.start();
  const note = translate('sandboxSetup.commandsUnavailable', 'zh-CN');
  assert.match(note, /命令暂时不可用/);
  // The status line keeps saying ready: the Host, the session and file editing all still work.
  assert.equal(
    runStatusText({
      status: 'idle',
      compacting: false,
      approvals: 0,
      questions: 0,
      ready: true,
      loading: false,
    }),
    translate('ui.ready', 'zh-CN'),
  );
});

test('dismissing lasts until the session moves back onto the sandbox', async () => {
  const { controller } = fixture({ reply: async () => ({ ok: true, view: uninitialized }) });
  await controller.start();
  controller.setMode('native');
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), true);
  controller.dismiss();
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), false);
  controller.setMode('host');
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), false);
  controller.setMode('native');
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), true);
});

test('a session in full access is not asked to set up the sandbox', async () => {
  const { controller } = fixture({ reply: async () => ({ ok: true, view: uninitialized }) });
  await controller.start();
  controller.setMode('host');
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), false);
});

test('a damaged installation asks for the live diagnostic once and offers repair', async () => {
  const calls: SandboxSetupCommand[] = [];
  const { controller } = fixture({
    reply: async (command) => {
      calls.push(command);
      if (command.type === 'verify')
        return { ok: true, view: { ...damaged, details: ['live detail'] } };
      return { ok: true, view: damaged };
    },
  });
  await controller.start();
  assert.deepEqual(calls, [{ type: 'status' }, { type: 'verify' }]);
  const state = controller.store.getSnapshot();
  assert.equal(sandboxPromptVisible(state), true);
  assert.equal(sandboxPromptTitleKey(state.view?.state), 'sandboxSetup.prompt.repairTitle');
  assert.match(t('sandboxSetup.damaged'), /沙箱账户需要修复/);
});

test('a rejected initialize releases the controls and keeps retry possible', async () => {
  const { controller } = fixture({
    reply: async (command) =>
      command.type === 'initialize'
        ? { ok: false, error: 'elevation cancelled' }
        : { ok: true, view: uninitialized },
  });
  await controller.start();
  await controller.request({ type: 'initialize', acknowledge: true });
  let state = controller.store.getSnapshot();
  assert.equal(state.pending, false);
  assert.equal(sandboxPromptFeedback(state), 'elevation cancelled');
  await controller.request({ type: 'initialize', acknowledge: true });
  state = controller.store.getSnapshot();
  assert.equal(state.pending, false);
});

test('a browser bridge without the helper shows nothing', async () => {
  const { controller, commands } = fixture({ api: false });
  await controller.start();
  assert.deepEqual(commands, []);
  assert.equal(sandboxPromptVisible(controller.store.getSnapshot()), false);
});

test('the weaker sandbox switches only after the person confirms', async () => {
  const { controller, presets } = fixture({
    reply: async () => ({ ok: true, view: uninitialized }),
    confirm: () => false,
  });
  await controller.start();
  await controller.chooseWeak();
  assert.deepEqual(presets, []);
  const confirmed = fixture({ reply: async () => ({ ok: true, view: uninitialized }) });
  await confirmed.controller.start();
  await confirmed.controller.chooseWeak();
  assert.deepEqual(confirmed.presets, [{ type: 'weak-sandbox', acknowledgeWeak: true }]);
});

test('a weaker-sandbox failure is reported and releases the prompt', async () => {
  const { controller } = fixture({
    reply: async () => ({ ok: true, view: uninitialized }),
    presets: async () => ({ ok: false, error: 'no administrator' }),
  });
  await controller.start();
  await controller.chooseWeak();
  const state = controller.store.getSnapshot();
  assert.equal(state.pending, false);
  assert.equal(sandboxPromptFeedback(state), 'no administrator');
});

test('disposing stops a late answer from changing the state', async () => {
  let release: ((reply: SandboxSetupReply) => void) | undefined;
  const { controller } = fixture({
    reply: () =>
      new Promise<SandboxSetupReply>((resolve) => {
        release = resolve;
      }),
  });
  const start = controller.start();
  await flush();
  controller.dispose();
  release?.({ ok: true, view: uninitialized });
  await start;
  assert.equal(controller.store.getSnapshot().view, null);
});
