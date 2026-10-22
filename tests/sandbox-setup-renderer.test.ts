import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSandboxInitialization } from '../apps/desktop/renderer-sandbox-setup.ts';
import type { SandboxSetupCommand, SandboxSetupReply } from '../apps/desktop/sandbox-setup.ts';

class Node {
  hidden = true;
  disabled = false;
  textContent = '';
  classList = { toggle() {} };
  handlers = new Map<string, () => Promise<void>>();
  addEventListener(event: string, handler: () => Promise<void>) {
    this.handlers.set(event, handler);
  }
  async click() {
    if (!this.disabled) await this.handlers.get('click')?.();
  }
}
async function page(api?: (command: SandboxSetupCommand) => Promise<SandboxSetupReply>) {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ids = new Map(
    ['section', 'title', 'note', 'feedback', 'initialize', 'refresh', 'uninstall'].map((part) => [
      `sandbox-setup-${part}`,
      new Node(),
    ]),
  );
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { yuantu: { sandboxSetup: api } },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (id: string) => ids.get(id),
    },
  });
  setupSandboxInitialization();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    node: (part: string) => ids.get(`sandbox-setup-${part}`)!,
    restore() {
      if (beforeWindow) Object.defineProperty(globalThis, 'window', beforeWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}

test('refresh requests a live diagnostic instead of the fast status', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return {
      ok: true,
      view: { supported: true, ready: true, installed: false, reason: null },
    };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    await fixture.node('refresh').click();
    assert.deepEqual(commands[1], { type: 'verify' });
  } finally {
    fixture.restore();
  }
});

test('opening settings only reads status and initialization requires a deliberate click', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return {
      ok: true,
      view: {
        supported: true,
        ready: true,
        installed: command.type === 'initialize',
        reason: null,
      },
    };
  });
  try {
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.equal(fixture.node('section').hidden, false);
    assert.equal(fixture.node('initialize').disabled, false);
    await fixture.node('initialize').click();
    assert.deepEqual(commands[1], { type: 'initialize', acknowledge: true });
    assert.equal(fixture.node('initialize').disabled, true);
    assert.equal(fixture.node('refresh').disabled, false);
  } finally {
    fixture.restore();
  }
});

test('cancelled or rejected initialization releases controls and preserves retry', async () => {
  let count = 0;
  const fixture = await page(async (command) => {
    if (command.type === 'initialize') {
      if (++count === 1) throw new Error('UAC cancelled');
      return { ok: false, error: 'Policy verification failed' };
    }
    return { ok: true, view: { supported: true, ready: true, installed: false, reason: null } };
  });
  try {
    await fixture.node('initialize').click();
    assert.equal(fixture.node('initialize').disabled, false);
    assert.equal(fixture.node('refresh').disabled, false);
    assert.match(fixture.node('feedback').textContent, /cancelled/);
    await fixture.node('initialize').click();
    assert.equal(count, 2);
    assert.equal(fixture.node('initialize').disabled, false);
    assert.match(fixture.node('feedback').textContent, /verification failed/);
  } finally {
    fixture.restore();
  }
});

test('unsupported platforms and browser bridges keep administrator controls hidden', async () => {
  for (const api of [
    undefined,
    async () => ({
      ok: true as const,
      view: { supported: false, ready: false, installed: false, reason: 'platform' as const },
    }),
  ]) {
    const fixture = await page(api);
    try {
      assert.equal(fixture.node('section').hidden, true);
    } finally {
      fixture.restore();
    }
  }
});

test('an unavailable helper cannot enable the initialization button', async () => {
  const commands: SandboxSetupCommand[] = [];
  const fixture = await page(async (command) => {
    commands.push(command);
    return {
      ok: true,
      view: { supported: true, ready: false, installed: false, reason: 'unavailable' },
    };
  });
  try {
    assert.equal(fixture.node('initialize').disabled, true);
    await fixture.node('initialize').click();
    assert.deepEqual(commands, [{ type: 'status' }]);
    assert.match(fixture.node('feedback').textContent, /cannot read|无法读取/i);
  } finally {
    fixture.restore();
  }
});

test('damaged accounts show the reason and offer repair and uninstall', async () => {
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
        state: command.type === 'uninstall' ? 'uninitialized' : 'damaged',
        problems: ['logon-failed'],
      },
    };
  });
  try {
    assert.match(fixture.node('feedback').textContent, /密码|password/i);
    assert.equal(fixture.node('uninstall').disabled, false);
    assert.equal(fixture.node('initialize').disabled, false);
    await fixture.node('uninstall').click();
    assert.deepEqual(commands[1], { type: 'uninstall', acknowledge: true });
    assert.equal(fixture.node('uninstall').disabled, true);
  } finally {
    fixture.restore();
  }
});
