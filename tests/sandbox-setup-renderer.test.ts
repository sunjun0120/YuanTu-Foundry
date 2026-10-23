import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSandboxInitialization } from '../apps/desktop/renderer-sandbox-setup.ts';
import type {
  SandboxSetupCommand,
  SandboxSetupReply,
  SandboxSetupView,
} from '../apps/desktop/sandbox-setup.ts';

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
/** Every button the advanced list drew, in order. */
function listButtons(list: Node): Node[] {
  return list.children.flatMap((item) => item.children.filter((child) => child.tag === 'button'));
}
async function page(api?: (command: SandboxSetupCommand) => Promise<SandboxSetupReply>) {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ids = new Map<string, Node>();
  for (const part of ['section', 'title', 'feedback', 'uninstall'])
    ids.set(`sandbox-setup-${part}`, new Node());
  for (const part of ['advanced', 'advanced-title', 'roots', 'add'])
    ids.set(`sandbox-read-${part}`, new Node());
  ids.set('sandbox-prompt', new Node());
  for (const part of ['title', 'note', 'feedback', 'initialize', 'dismiss'])
    ids.set(`sandbox-prompt-${part}`, new Node());
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { yuantu: { sandboxSetup: api } },
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
    node: (part: string) => ids.get(`sandbox-setup-${part}`)!,
    read: (part: string) => ids.get(`sandbox-read-${part}`)!,
    prompt: (part?: string) => ids.get(part ? `sandbox-prompt-${part}` : 'sandbox-prompt')!,
    restore() {
      if (beforeWindow) Object.defineProperty(globalThis, 'window', beforeWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}
const ready = (readRoots: SandboxSetupView['readRoots']): SandboxSetupView => ({
  supported: true,
  ready: true,
  installed: true,
  reason: null,
  state: 'ready',
  readRoots,
});

const uninitialized: SandboxSetupView = {
  supported: true,
  ready: true,
  installed: false,
  reason: null,
  state: 'uninitialized',
  readRoots: [],
};

test('ready accounts are a settings section and no composer prompt', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return {
      ok: true,
      view: ready([
        { path: 'C:\Users\Alice\.cargo\bin', source: 'auto' },
        { path: 'D:\Tools', source: 'user' },
      ]),
    };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.equal(fixture.node('section').hidden, false);
    assert.equal(fixture.prompt().hidden, true);
    assert.match(fixture.node('feedback').textContent, /就绪|ready/i);
    assert.equal(fixture.node('uninstall').disabled, false);
    assert.equal(fixture.read('roots').children.length, 2);
    // Only the user's own root can be removed; the automatic one is marked as such.
    const buttons = listButtons(fixture.read('roots'));
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.textContent, '移除');
    await buttons[0]!.click();
    assert.deepEqual(commands[1], {
      type: 'read-remove',
      path: 'D:\Tools',
      acknowledge: true,
    });
  } finally {
    fixture.restore();
  }
});

test('uninitialized accounts are offered above the composer, not in settings', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return { ok: true, view: uninitialized };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.equal(fixture.node('section').hidden, true);
    assert.equal(fixture.prompt().hidden, false);
    assert.equal(fixture.prompt('title').textContent, '设置 Windows 沙箱');
    assert.equal(fixture.prompt('initialize').disabled, false);
    await fixture.prompt('initialize').click();
    assert.deepEqual(commands[1], { type: 'initialize', acknowledge: true });
  } finally {
    fixture.restore();
  }
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
    assert.equal(fixture.node('section').hidden, true);
    assert.equal(fixture.prompt().hidden, false);
    assert.match(fixture.prompt('note').textContent, /密码|password/i);
    assert.equal(fixture.prompt('initialize').textContent, '立即修复');
  } finally {
    fixture.restore();
  }
});

test('the add button asks the main process to pick a directory', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return { ok: true, view: ready([]) };
  });
  try {
    const add = fixture.read('add');
    assert.equal(add.disabled, false);
    assert.equal(add.textContent, '添加目录…');
    await add.click();
    assert.deepEqual(commands[1], { type: 'read-add', acknowledge: true });
  } finally {
    fixture.restore();
  }
});

test('uninstalling from settings brings the setup prompt back', async () => {
  let installed = true;
  const fixture = await page(async (command) => {
    if (command.type === 'uninstall') installed = false;
    return { ok: true, view: installed ? ready([]) : uninitialized };
  });
  try {
    await fixture.node('uninstall').click();
    assert.equal(fixture.node('section').hidden, true);
    assert.equal(fixture.prompt().hidden, false);
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
      assert.equal(fixture.node('section').hidden, true);
      assert.equal(fixture.prompt().hidden, true);
    } finally {
      fixture.restore();
    }
  }
});
