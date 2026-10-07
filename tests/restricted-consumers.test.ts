import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { TerminalSessions } from '../packages/tools/terminal.ts';
import { executionPolicy, withExecutionPolicy } from '../packages/tools/execution-policy.ts';
import { LspClient } from '../packages/lsp/client.ts';
import { LspManager } from '../packages/lsp/manager.ts';
import { pathToUri } from '../packages/lsp/protocol.ts';
import { sandboxProvider, registerSandboxProvider } from '../packages/tools/sandbox.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const windows = { skip: process.platform !== 'win32', timeout: 60000 };
const fixture = path.resolve('tests/lsp-fixture.ts');
const context = (mode: 'host' | 'windows' | 'docker' = 'windows'): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  executionPolicy: executionPolicy(mode),
});

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
async function waitUntil(check: () => boolean | Promise<boolean>, ms = 12000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting for independent evidence');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function exists(file: string) {
  return Boolean(await stat(file).catch(() => undefined));
}
const resources = new Map<string, Array<() => unknown | Promise<unknown>>>();
function own(root: string, cleanup: () => unknown | Promise<unknown>) {
  resources.get(root)!.push(cleanup);
}
async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-restricted-consumer-'));
  resources.set(root, []);
  t.after(async () => {
    for (const cleanup of resources.get(root)!) await cleanup();
    resources.delete(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}

test(
  'a restricted terminal handles input and Ctrl+C, confines writes and joins close',
  windows,
  async (t) => {
    const root = await workspace(t);
    const outside = await workspace(t);
    const script = path.join(root, 'repl.cjs');
    await writeFile(
      script,
      `const fs=require('fs');console.log('READY',process.stdin.isTTY,process.stdout.isTTY);fs.writeFileSync('inside.txt','inside');try{fs.writeFileSync(${JSON.stringify(path.join(outside, 'denied.txt'))},'outside');console.log('OUTSIDE_WRITTEN')}catch{console.log('OUTSIDE_DENIED')}process.on('SIGINT',()=>console.log('INTERRUPTED'));process.stdin.on('data',b=>{const s=String(b).trim();console.log('INPUT',s);if(s==='exit')process.exit(0)});`,
    );
    const manager = new TerminalSessions(root);
    own(root, () => manager.closeAllAndWait());
    const tools = createTools(root, undefined, 's', undefined, undefined, manager);
    own(root, () => tools.close());
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await tools.execute(
        { id: crypto.randomUUID(), name, arguments: args },
        context(),
      );
      assert.equal(result.isError, false, result.content);
      return result;
    };
    const opened = await call('terminal_open', { command: process.execPath, args: [script] });
    const id = /Terminal (\S+) started/.exec(opened.content)![1]!;
    const output = async () => (await manager.read(id, 's', 0)).snapshot.output;
    await waitUntil(async () => (await output()).includes('OUTSIDE_DENIED'));
    assert.match(await output(), /READY true true/);
    assert.equal(await readFile(path.join(root, 'inside.txt'), 'utf8'), 'inside');
    assert.equal(await exists(path.join(outside, 'denied.txt')), false);
    await call('terminal_send', { id, input: 'ping' });
    await waitUntil(async () => (await output()).includes('INPUT ping'));
    await call('terminal_signal', { id, signal: 'SIGINT' });
    await waitUntil(async () => (await output()).includes('INTERRUPTED'));
    const switched = await tools.execute(
      { id: 'switch', name: 'terminal_send', arguments: { id, input: 'exit' } },
      context('host'),
    );
    assert.equal(switched.isError, true);
    assert.match(switched.content, /creation policy|created under|policy changed/i);
    await call('terminal_send', { id, input: 'exit' });
    await waitUntil(() => manager.list('s')[0]!.status === 'exited');
    await call('terminal_close', { id });
  },
);

test(
  'a Windows language server shares file paths and approved multi-file edits',
  windows,
  async (t) => {
    const root = await workspace(t);
    const outside = await workspace(t);
    await mkdir(path.join(root, '.yuantu'));
    const marker = path.join(root, 'lifecycle');
    const wrapper = path.join(root, 'server.mjs');
    await writeFile(
      wrapper,
      `import fs from 'node:fs';import {pathToFileURL} from 'node:url';let denied=false;try{fs.writeFileSync(${JSON.stringify(path.join(outside, 'denied.txt'))},'outside')}catch{denied=true}fs.writeFileSync('server-probe.json',JSON.stringify({denied,cwd:process.cwd(),pid:process.pid,marker:process.env.FAKE_LSP_LIFECYCLE_MARKER}));await import(pathToFileURL(${JSON.stringify(fixture)}).href);`,
    );
    await writeFile(
      path.join(root, '.yuantu/lsp.json'),
      JSON.stringify({
        servers: {
          fake: {
            command: process.execPath,
            args: [wrapper],
            extensions: ['.fake'],
            env: { FAKE_LSP_LIFECYCLE_MARKER: marker },
          },
        },
      }),
    );
    await writeFile(path.join(root, 'main.fake'), 'TARGET BADTOKEN\nMULTIFILE\n');
    await writeFile(path.join(root, 'second.fake'), 'TARGET second\n');
    const tools = createTools(root);
    own(root, () => tools.close());
    const call = async (name: string, args: Record<string, unknown>, ctx = context()) =>
      tools.execute({ id: crypto.randomUUID(), name, arguments: args }, ctx);
    const started = await call('lsp_start', { language: 'fake' });
    assert.equal(started.isError, false, started.content);
    const probe = JSON.parse(await readFile(path.join(root, 'server-probe.json'), 'utf8'));
    assert.equal(probe.denied, true);
    assert.equal(probe.cwd, root);
    assert.equal(probe.marker, marker);
    assert.equal(await readFile(marker + '.pid', 'utf8'), String(probe.pid));
    assert.equal(await exists(path.join(outside, 'denied.txt')), false);
    assert.match(
      (await call('lsp_diagnostics', { paths: ['main.fake'] })).content,
      /BADTOKEN is not allowed/,
    );
    assert.match(
      (await call('lsp_definition', { path: 'main.fake', line: 1, character: 1 })).content,
      /main.fake/,
    );
    const rename = { path: 'main.fake', line: 1, character: 1, new_name: 'RENAMED' };
    const denied = await call('lsp_rename', rename, { ...context(), approve: async () => false });
    assert.equal(denied.isError, true);
    assert.match(await readFile(path.join(root, 'main.fake'), 'utf8'), /^TARGET/);
    const applied: string[] = [];
    const approved = await call('lsp_rename', rename, {
      ...context(),
      fileJournal: {
        prepare: () => 'single',
        prepareGroup: (_change, files) => {
          assert.deepEqual(files.map((f) => f.path).sort(), ['main.fake', 'second.fake']);
          return 'group';
        },
        applied: (id) => applied.push(id),
      },
    });
    assert.equal(approved.isError, false, approved.content);
    assert.match(await readFile(path.join(root, 'main.fake'), 'utf8'), /^RENAMED/);
    assert.match(await readFile(path.join(root, 'second.fake'), 'utf8'), /^RENAMED/);
    assert.deepEqual(applied, ['group']);
    let actionApprovals = 0;
    const action = await call(
      'lsp_apply_code_action',
      { path: 'main.fake', line: 1, character: 1, index: 1 },
      {
        ...context(),
        approve: async (approval) => {
          assert.equal(approval.kind, 'write');
          actionApprovals++;
          return true;
        },
      },
    );
    assert.equal(action.isError, false, action.content);
    assert.equal(actionApprovals, 1);
    assert.match(await readFile(path.join(root, 'main.fake'), 'utf8'), /GOODTOKEN/);
    const mismatch = await call('lsp_diagnostics', { paths: ['main.fake'] }, context('host'));
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content, /creation policy|created under|policy changed/i);
    const stopped = await call('lsp_stop', { language: 'fake' }, context('host'));
    assert.equal(stopped.isError, false, stopped.content);
    assert.equal(await readFile(marker, 'utf8'), 'ok');
    assert.equal(await readFile(marker + '.exited', 'utf8'), 'ok');
    const pid = Number(await readFile(marker + '.pid', 'utf8'));
    assert.throws(() => process.kill(pid, 0));
  },
);

test(
  'a restricted LSP cancellation reaches the server and stop joins cleanup',
  windows,
  async (t) => {
    const root = await workspace(t);
    const marker = path.join(root, 'lifecycle'),
      cancel = path.join(root, 'cancel');
    await withExecutionPolicy(executionPolicy('windows'), async () => {
      const client = new LspClient(
        {
          language: 'fake',
          command: process.execPath,
          args: [fixture, '--never-answer'],
          extensions: ['.fake'],
          env: { FAKE_LSP_LIFECYCLE_MARKER: marker, FAKE_LSP_CANCEL_MARKER: cancel },
        },
        root,
      );
      own(root, () => client.stop());
      await client.start(AbortSignal.timeout(15000));
      await assert.rejects(
        client.send(
          'textDocument/definition',
          {
            textDocument: { uri: pathToUri(path.join(root, 'main.fake')) },
            position: { line: 0, character: 0 },
          },
          AbortSignal.timeout(200),
        ),
        /Timeout|abort/i,
      );
      await waitUntil(() => exists(cancel));
      assert.match(await readFile(cancel, 'utf8'), /\d/);
      await client.stop();
      const pid = Number(await readFile(marker + '.pid', 'utf8'));
      assert.throws(() => process.kill(pid, 0));
    });
  },
);

test('unsupported LSP backends stay refused without launching a process', async (t) => {
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
  await withExecutionPolicy(executionPolicy('docker'), async () => {
    await assert.rejects(
      manager.start('fake', new AbortController().signal),
      /unsupported|disabled outside host/,
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
      await withExecutionPolicy(executionPolicy('windows'), async () => {
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

test('closing a restricted terminal kills its descendant before returning', windows, async (t) => {
  const root = await workspace(t);
  const manager = new TerminalSessions(root);
  own(root, () => manager.closeAllAndWait());
  const script = path.join(root, 'tree.cjs');
  await writeFile(
    script,
    `const{spawn}=require('child_process');const child=spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('late.txt','unexpected'),1800);setInterval(()=>{},1000)"],{stdio:'ignore'});console.log('CHILD',child.pid);setInterval(()=>{},1000);`,
  );
  const opened = await manager.open({ command: process.execPath, args: [script] }, context(), 's');
  let output = '';
  await waitUntil(async () => {
    output = (await manager.read(opened.id, 's', 0)).snapshot.output;
    return /CHILD \d+/.test(output);
  });
  const pid = Number(/CHILD (\d+)/.exec(output)![1]);
  await manager.closeAndWait(opened.id, 's');
  assert.throws(() => process.kill(pid, 0));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await exists(path.join(root, 'late.txt')), false);
});

for (const flag of ['--reject-on-start', '--malformed-output'])
  test('restricted LSP cleans up ' + flag, windows, async (t) => {
    const root = await workspace(t);
    const marker = path.join(root, 'lifecycle');
    await withExecutionPolicy(executionPolicy('windows'), async () => {
      const client = new LspClient(
        {
          language: 'fake',
          command: process.execPath,
          args: [fixture, flag],
          extensions: ['.fake'],
          env: { FAKE_LSP_LIFECYCLE_MARKER: marker },
        },
        root,
      );
      own(root, () => client.stop());
      if (flag === '--reject-on-start')
        await assert.rejects(client.start(AbortSignal.timeout(15000)), /fake|error/i);
      else {
        await client
          .start(AbortSignal.timeout(15000))
          .catch((error) => assert.match(String(error), /Content-Length|frame/i));
        await waitUntil(() => !client.running);
        assert.match(client.lastError ?? '', /Content-Length|frame/i);
      }
      await client.stop();
      const pid = Number(await readFile(marker + '.pid', 'utf8'));
      assert.throws(() => process.kill(pid, 0));
    });
  });
