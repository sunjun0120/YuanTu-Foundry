import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSandboxInitialization } from '../apps/desktop/renderer-sandbox-setup.ts';
import { commandsNeedSandboxAccounts } from '../apps/desktop/renderer-sandbox-setup.ts';
import { runStatusText } from '../apps/desktop/renderer-status.ts';
import { translate } from '../apps/desktop/i18n.ts';
import type {
  SandboxSetupCommand,
  SandboxSetupReply,
  SandboxSetupView,
} from '../apps/desktop/sandbox-setup.ts';
import type { PermissionPresetCommand } from '../apps/desktop/permission-presets.ts';

class Node {
  hidden = true;
  disabled = false;
  textContent = '';
  className = '';
  type = '';
  tag = '';
  children: Node[] = [];
  classList = { toggle() {} };
  handlers = new Map<string, () => Promise<void>>();
  addEventListener(event: string, handler: () => Promise<void>) {
    this.handlers.set(event, handler);
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this.children = [...nodes];
  }
  async click() {
    if (!this.disabled) await this.handlers.get('click')?.();
  }
}
async function page(
  api?: (command: SandboxSetupCommand) => Promise<SandboxSetupReply>,
  extra: {
    presets?: (command: PermissionPresetCommand) => Promise<unknown>;
    confirm?: () => boolean;
  } = {},
) {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ids = new Map<string, Node>();
  ids.set('sandbox-prompt', new Node());
  for (const part of ['title', 'note', 'feedback', 'initialize', 'dismiss', 'weak'])
    ids.set(`sandbox-prompt-${part}`, new Node());
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      yuantu: { sandboxSetup: api, presets: extra.presets },
      confirm: extra.confirm ?? (() => false),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (id: string) => ids.get(id),
      createElement: (tag: string) => {
        const node = new Node();
        node.tag = tag;
        node.hidden = false;
        return node;
      },
    },
  });
  const control = setupSandboxInitialization();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    control,
    prompt: (part?: string) => ids.get(part ? `sandbox-prompt-${part}` : 'sandbox-prompt')!,
    restore() {
      if (beforeWindow) Object.defineProperty(globalThis, 'window', beforeWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}
const ready: SandboxSetupView = {
  supported: true,
  ready: true,
  installed: true,
  reason: null,
  state: 'ready',
  readRoots: [{ path: 'C:\Users\Alice\.cargo\bin', source: 'auto' }],
};

const uninitialized: SandboxSetupView = {
  supported: true,
  ready: true,
  installed: false,
  reason: null,
  state: 'uninitialized',
  readRoots: [],
};

test('ready accounts draw nothing: no prompt and nothing to send', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return { ok: true, view: ready };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.equal(fixture.prompt().hidden, true);
  } finally {
    fixture.restore();
  }
});

test('uninitialized accounts are offered above the composer', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return { ok: true, view: uninitialized };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.equal(fixture.prompt().hidden, false);
    assert.equal(fixture.prompt('title').textContent, '设置 Windows 沙箱');
    assert.equal(fixture.prompt('initialize').disabled, false);
    await fixture.prompt('initialize').click();
    assert.deepEqual(commands[1], { type: 'initialize', acknowledge: true });
  } finally {
    fixture.restore();
  }
});

test('commands are announced as unavailable, and the rest of the application is not', async () => {
  const fixture = await page(async () => ({ ok: true, view: uninitialized }));
  try {
    const note = fixture.prompt('note').textContent;
    assert.match(note, /命令暂时不可用/);
    assert.match(note, /不受影响/);
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
  } finally {
    fixture.restore();
  }
});

test('only a native preset with uninitialized accounts needs the setup', () => {
  // Four states the interface has to tell apart; only one of them means commands cannot run.
  assert.equal(
    commandsNeedSandboxAccounts({ mode: 'native', state: 'uninitialized' }),
    true,
    'native + uninitialized',
  );
  assert.equal(
    commandsNeedSandboxAccounts({ mode: 'native', state: 'ready' }),
    false,
    'native + initialized',
  );
  assert.equal(
    commandsNeedSandboxAccounts({ mode: 'windows', state: 'uninitialized' }),
    false,
    'the weaker backend does not use the accounts',
  );
  assert.equal(
    commandsNeedSandboxAccounts({ mode: 'host', state: 'uninitialized' }),
    false,
    'the host backend does not use the accounts',
  );
  // A damaged backend refuses commands just as hard as a missing one, and an unrecorded preset is native.
  assert.equal(commandsNeedSandboxAccounts({ mode: 'windows-account', state: 'damaged' }), true);
  assert.equal(commandsNeedSandboxAccounts({ mode: undefined, state: 'uninitialized' }), true);
});

test('dismissing the prompt lasts until the session moves back onto the sandbox', async () => {
  const fixture = await page(async () => ({ ok: true, view: uninitialized }));
  try {
    await fixture.prompt('dismiss').click();
    assert.equal(fixture.prompt().hidden, true);
    fixture.control.setMode('native');
    assert.equal(fixture.prompt().hidden, true);
    // Full access does not need the accounts at all.
    fixture.control.setMode('host');
    assert.equal(fixture.prompt().hidden, true);
    fixture.control.setMode('native');
    assert.equal(fixture.prompt().hidden, false);
  } finally {
    fixture.restore();
  }
});

test('a session in full access is not asked to set up the sandbox', async () => {
  const fixture = await page(async () => ({ ok: true, view: uninitialized }));
  try {
    fixture.control.setMode('host');
    assert.equal(fixture.prompt().hidden, true);
  } finally {
    fixture.restore();
  }
});

test('a damaged installation asks for the live diagnostic once and offers repair', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return {
      ok: true,
      view: {
        supported: true,
        ready: true,
        installed: false,
        reason: null,
        state: 'damaged',
        problems: ['logon-failed'],
        details: ['credentials: cannot decrypt offline'],
      },
    };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }, { type: 'verify' }]);
    assert.equal(fixture.prompt().hidden, false);
    assert.match(fixture.prompt('note').textContent, /密码|password/i);
    assert.equal(fixture.prompt('initialize').textContent, '立即修复');
  } finally {
    fixture.restore();
  }
});

test('cancelled or rejected setup releases controls and preserves retry', async () => {
  let count = 0;
  const fixture = await page(async (command) => {
    if (command.type === 'initialize') {
      if (++count === 1) throw new Error('UAC cancelled');
      return { ok: false, error: 'Policy verification failed' };
    }
    return { ok: true, view: uninitialized };
  });
  try {
    await fixture.prompt('initialize').click();
    assert.equal(fixture.prompt('initialize').disabled, false);
    assert.match(fixture.prompt('feedback').textContent, /cancelled/);
    await fixture.prompt('initialize').click();
    assert.equal(count, 2);
    assert.equal(fixture.prompt('initialize').disabled, false);
    assert.match(fixture.prompt('feedback').textContent, /verification failed/);
  } finally {
    fixture.restore();
  }
});

test('unsupported platforms, browser bridges and a missing helper show nothing', async () => {
  for (const api of [
    undefined,
    async () => ({
      ok: true as const,
      view: { supported: false, ready: false, installed: false, reason: 'platform' as const },
    }),
    async () => ({
      ok: true as const,
      view: { supported: true, ready: false, installed: false, reason: 'unavailable' as const },
    }),
  ]) {
    const fixture = await page(api);
    try {
      assert.equal(fixture.prompt().hidden, true);
    } finally {
      fixture.restore();
    }
  }
});

test('the weaker sandbox switches the session only after the person confirms', async () => {
  const sent: PermissionPresetCommand[] = [];
  let confirmed = false;
  const fixture = await page(async () => ({ ok: true, view: uninitialized }), {
    presets: async (command) => {
      sent.push(command);
      return { ok: true };
    },
    confirm: () => confirmed,
  });
  try {
    assert.match(fixture.prompt('weak').textContent, /较弱沙箱/);
    await fixture.prompt('weak').click();
    assert.deepEqual(sent, [], 'a declined confirmation changes nothing');
    confirmed = true;
    await fixture.prompt('weak').click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [{ type: 'weak-sandbox', acknowledgeWeak: true }]);
    // The session is now on the restricted token and no longer needs the accounts.
    fixture.control.setMode('windows');
    assert.equal(fixture.prompt().hidden, true);
    // Choosing a preset again moves back onto the account sandbox, which asks for setup again.
    fixture.control.setMode('native');
    assert.equal(fixture.prompt().hidden, false);
  } finally {
    fixture.restore();
  }
});
