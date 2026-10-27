import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executionPolicy, withExecutionPolicy } from '../packages/tools/execution-policy.ts';
import { LspClient } from '../packages/lsp/client.ts';
import { LspManager } from '../packages/lsp/manager.ts';
import { sandboxProvider, registerSandboxProvider } from '../packages/tools/sandbox.ts';
import { fixture, own, workspace } from './restricted-consumers-fixture.ts';

test('cancelling LSP startup during workspace resolution prevents backend preparation', async (t) => {
  const root = await workspace(t);
  const original = sandboxProvider('host');
  let prepared = 0;
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      prepared++;
      return original.prepare(request);
    },
  });
  try {
    await withExecutionPolicy(executionPolicy('host'), async () => {
      const client = new LspClient(
        { language: 'fake', command: process.execPath, args: [fixture], extensions: ['.fake'] },
        root,
      );
      own(root, () => client.stop());
      const controller = new AbortController();
      const starting = client.start(controller.signal);
      controller.abort(new Error('startup cancelled'));
      await assert.rejects(starting, /startup cancelled/);
      assert.equal(prepared, 0);
    });
  } finally {
    registerSandboxProvider(original);
  }
});

test('unsupported LSP backends stay refused without launching a process', async (t) => {
  const original = sandboxProvider('seatbelt');
  registerSandboxProvider({ ...original, available: async () => 'fixture backend unavailable' });
  t.after(() => registerSandboxProvider(original));
  const root = await workspace(t);
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(
    path.join(root, '.yuantu/lsp.json'),
    JSON.stringify({
      servers: { fake: { command: process.execPath, args: [fixture], extensions: ['.fake'] } },
    }),
  );
  const manager = new LspManager(root);
  own(root, () => manager.close());
  await withExecutionPolicy(executionPolicy('seatbelt'), async () => {
    await assert.rejects(
      manager.start('fake', new AbortController().signal),
      /fixture backend unavailable/,
    );
    assert.deepEqual(manager.runningLanguages(), []);
  });
});

test(
  'concurrent LSP starts share one server and manager close joins startup',
  { timeout: 15000 },
  async (t) => {
    const root = await workspace(t);
    await mkdir(path.join(root, '.yuantu'));
    await writeFile(
      path.join(root, '.yuantu/lsp.json'),
      JSON.stringify({
        servers: { fake: { command: process.execPath, args: [fixture], extensions: ['.fake'] } },
      }),
    );
    const manager = new LspManager(root);
    await withExecutionPolicy(executionPolicy('host'), async () => {
      const clients = await Promise.all([
        manager.start('fake', new AbortController().signal),
        manager.start('fake', new AbortController().signal),
      ]);
      own(root, async () => {
        await Promise.all(clients.map((c) => c.stop()));
        await manager.close();
      });
      assert.equal(clients[0] === clients[1], true, 'concurrent callers must share one client');
      await withExecutionPolicy(executionPolicy('windows-account'), async () => {
        assert.throws(
          () => clients[0]!.send('workspace/symbol', { query: 'x' }, new AbortController().signal),
          /creation policy/,
        );
      });
      await manager.close();
      assert.equal(clients[0]!.running, false);
    });
  },
);

test('closing an LSP manager during startup leaves no late server', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(
    path.join(root, '.yuantu/lsp.json'),
    JSON.stringify({
      servers: { fake: { command: process.execPath, args: [fixture], extensions: ['.fake'] } },
    }),
  );
  const manager = new LspManager(root);
  own(root, () => manager.close());
  await withExecutionPolicy(executionPolicy('host'), async () => {
    const started = manager.start('fake', new AbortController().signal);
    await manager.close();
    const client = await started;
    assert.equal(client.running, false);
    await assert.rejects(manager.start('fake', new AbortController().signal), /closing/);
  });
});
