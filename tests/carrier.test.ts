/**
 * The carrier service as a thing in its own right.
 *
 * `apps/desktop` used to own the whole client state machine: the command vocabulary, the snapshot the interface
 * renders, the recovery behaviour and the session bookkeeping all lived in one Electron-shaped file. The
 * carrier-agnostic part moved into `packages/carrier/`; the shell
 * keeps the window, the menus, the IPC forwarding and the settings stores. What these tests pin is the claim
 * that made the move worth doing:
 *
 * 1. the package has no Electron and no DOM in it (read from the sources, not promised in a comment), and
 * 2. one service drives both transport shapes — a Host it spawned itself, and a Host somebody else started and
 *    handed it a socket to — in plain Node, with no shell anywhere in the process.
 *
 * The second point is the whole project: everything above the transport is shared code, so a second carrier
 * wires up a link and gets the state machine rather than a copy of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CarrierService,
  connectedCarrier,
  parseCarrierCommand,
  spawnedCarrier,
} from '../packages/carrier/index.ts';
import { socketTransport } from '../packages/client/host-transport.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectSocket, listeningHost } from './listening-host-fixture.ts';
import { projectRoot } from './process-fixture.ts';

/** Poll until `condition` holds, so a test does not encode a sleep that is either slow or flaky. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('the carrier package imports neither Electron nor the shell that consumes it', async () => {
  const directory = path.join(projectRoot, 'packages', 'carrier');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.ts')).sort();
  assert.ok(files.length >= 3, `the package has sources: ${files.join(', ')}`);
  const banned: [RegExp, string][] = [
    [/from\s+'electron'/, 'imports Electron'],
    [/from\s+'\.\.\/\.\.\/apps\//, 'imports an application shell'],
    [/\bwindow\s*\./, 'touches the DOM window'],
    [/\bdocument\s*\./, 'touches the DOM document'],
    [/\bHTMLElement\b/, 'names a DOM type'],
    [/\bnavigator\s*\./, 'touches the browser navigator'],
  ];
  for (const name of files) {
    const text = await readFile(path.join(directory, name), 'utf8');
    for (const [pattern, why] of banned)
      assert.doesNotMatch(text, pattern, `packages/carrier/${name} ${why}`);
  }
});

test('a spawned carrier drives a real Host in Node, with no shell in the process', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-node-'));
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('Carrier answer')));
  const carrier = spawnedCarrier({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps', 'agent-host', 'main.ts'),
    workspace: root,
    env: {
      YUANTU_API_KEY: 'carrier-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await carrier.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const stages: string[] = [];
  t.after(
    carrier.subscribe((snapshot) => {
      stages.push(snapshot.startupStage);
    }),
  );
  await carrier.start();
  assert.ok(carrier instanceof CarrierService);
  assert.equal(carrier.snapshot.ready, true);
  assert.equal(carrier.snapshot.host, 'ready');
  // The Host realpaths the workspace; the carrier reports what the Host says, not what it was handed.
  assert.equal(carrier.snapshot.workspace, await realpath(root));
  assert.ok(stages.includes('resources'), `stages seen: ${stages.join(', ')}`);
  assert.equal(carrier.snapshot.configured, true);
  assert.doesNotMatch(JSON.stringify(carrier.snapshot), /carrier-secret/);
  assert.equal(
    typeof carrier.snapshot.hostPid,
    'number',
    'this carrier owns the process, so it names it',
  );
  const snapshot = await carrier.dispatch({ type: 'send', prompt: 'Hello' });
  assert.equal(snapshot.session.messages.at(-1)?.content, 'Carrier answer');
  assert.equal(snapshot.sessions[0]?.title, 'Carrier answer');
  // The shell owns the clipboard, links, the save dialog and the folder picker. They travel in the same
  // vocabulary (one parser validates them for every carrier) and are refused here rather than silently ignored.
  await assert.rejects(
    carrier.dispatch({ type: 'chooseWorkspace' }),
    /belongs to the carrier shell/,
  );
});

test(
  'a recovered carrier restores its live sandbox and approval policy before accepting commands',
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-security-recovery-'));
    let toolResult: { is_error?: boolean; content: unknown } | undefined;
    let calls = 0;
    const url = await httpFixture(t, (body, res) => {
      if (calls++ === 0) {
        sendFrames(
          res,
          frames('', [
            {
              id: 'restored-command',
              name: 'run_command',
              input: { command: `node -e "console.log('RECOVERED_SANDBOX_OK')"` },
            },
          ]),
        );
      } else {
        const blocks: Array<{
          type: string;
          tool_use_id?: string;
          is_error?: boolean;
          content: unknown;
        }> = body.messages.flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [],
        );
        toolResult = blocks.find(
          (block) => block.type === 'tool_result' && block.tool_use_id === 'restored-command',
        );
        sendFrames(res, frames('Recovered command finished'));
      }
    });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: path.join(projectRoot, 'apps', 'agent-host', 'main.ts'),
      workspace: root,
      env: {
        YUANTU_SANDBOX: 'sbx',
        YUANTU_SESSION_TITLES: 'false',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_MODEL: 'fixture',
        YUANTU_API_KEY: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
        YUANTU_BASE_URL: url,
      },
    });
    t.after(async () => {
      await carrier.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await carrier.start();
    await carrier.dispatch({ type: 'sandbox', mode: 'host' });
    await carrier.updatePermissionPolicy({
      version: 1,
      rules: [{ effect: 'allow', kind: 'command' }],
    });
    const pid = carrier.snapshot.hostPid;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () =>
        carrier.snapshot.ready &&
        carrier.snapshot.hostPid !== pid &&
        carrier.snapshot.recovery !== null,
      'Host recovery',
    );
    await carrier.dispatch({ type: 'send', prompt: 'Run the restored command' });
    await waitFor(
      () => !carrier.snapshot.session.running && !carrier.snapshot.session.loading,
      'recovered command completion',
    );
    assert.equal(carrier.snapshot.session.approvals.length, 0);
    assert.ok(toolResult, 'the command must complete without falling back to an approval');
    assert.notEqual(toolResult.is_error, true);
    assert.match(JSON.stringify(toolResult.content), /RECOVERED_SANDBOX_OK/);
  },
);

test('the same service drives a Host it did not start, over a socket', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('From a listening Host')));
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const socket = await connectSocket(host.port);
  const carrier = connectedCarrier({
    transport: socketTransport(socket),
    env: {
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(() => carrier.stop().catch(() => {}));
  // Nothing is known about the workspace until the Host answers: a connected carrier has no path to guess with.
  assert.equal(carrier.snapshot.workspace, '');
  await carrier.start();
  assert.equal(carrier.snapshot.workspace, host.root);
  assert.equal(carrier.snapshot.hostPid, null, "the process is not this carrier's to name");
  const snapshot = await carrier.dispatch({ type: 'send', prompt: 'Hello' });
  assert.equal(snapshot.session.messages.at(-1)?.content, 'From a listening Host');
});

test('a carrier that does not own the Host reports the break instead of restarting it', async (t) => {
  const host = await listeningHost(t, {});
  const socket = await connectSocket(host.port);
  const carrier = connectedCarrier({ transport: socketTransport(socket), env: {} });
  t.after(() => carrier.stop().catch(() => {}));
  await carrier.start();
  assert.equal(carrier.snapshot.ready, true);
  host.child.kill('SIGKILL');
  await waitFor(() => carrier.snapshot.host === 'failed', 'the carrier to notice the Host died');
  assert.equal(carrier.snapshot.ready, false);
  assert.equal(carrier.snapshot.startupStage, 'failed');
  // Restarting is the link owner's job: this carrier has no process to start, so it says so and stops there
  // rather than pretending to recover (`recovery` is what a window shows when a restart did happen).
  assert.equal(carrier.snapshot.recovery, null);
  assert.match(carrier.snapshot.error ?? '', /连接已断开/);
});

test('one parser validates the vocabulary every carrier sends', () => {
  assert.deepEqual(parseCarrierCommand({ type: 'cancel' }), { type: 'cancel' });
  assert.deepEqual(parseCarrierCommand({ type: 'copyText', text: 'hi' }), {
    type: 'copyText',
    text: 'hi',
  });
  assert.throws(() => parseCarrierCommand({ type: 'exec', command: 'rm -rf /' }), {
    message: 'Invalid carrier command',
  });
});
