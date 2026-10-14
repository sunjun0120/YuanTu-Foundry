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
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
import { withoutComments } from '../scripts/i18n-gate.mjs';

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
    const text = withoutComments(await readFile(path.join(directory, name), 'utf8'));
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
        YUANTU_SANDBOX: 'native',
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
  assert.equal(carrier.snapshot.errorDetail?.code, 'hostDisconnected');
});

test(
  'recovery restores each session file policy instead of applying the last selection to the visible session',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-file-recovery-'));
    const results: Array<{ is_error?: boolean; content: unknown }> = [];
    const url = await httpFixture(t, (body, response) => {
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block: { type: string }) => block.type === 'tool_result')
        : undefined;
      if (result) {
        results.push(result);
        sendFrames(response, frames('done'));
      } else
        sendFrames(
          response,
          frames('', [
            {
              id: 'write',
              name: 'write_file',
              input: { path: results.length ? 'b.txt' : 'a.txt', content: 'written' },
            },
          ]),
        );
    });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: path.join(projectRoot, 'apps', 'agent-host', 'main.ts'),
      workspace: root,
      env: {
        YUANTU_SANDBOX: 'host',
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
    const a = carrier.snapshot.session.sessionId!;
    await carrier.dispatch({
      type: 'sandbox',
      mode: 'seatbelt',
      files: 'read-only',
      network: 'denied',
    });
    await carrier.dispatch({ type: 'create' });
    const b = carrier.snapshot.session.sessionId!;
    assert.notEqual(a, b);
    await carrier.dispatch({
      type: 'sandbox',
      mode: 'host',
      files: 'workspace-write',
      network: 'unrestricted',
    });
    await carrier.updatePermissionPolicy({
      version: 1,
      rules: [{ kind: 'write', effect: 'allow' }],
    });
    await carrier.dispatch({ type: 'load', id: a });
    const pid = carrier.snapshot.hostPid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () =>
        carrier.snapshot.ready &&
        carrier.snapshot.hostPid !== pid &&
        carrier.snapshot.recovery !== null,
      'policy recovery',
    );
    await carrier.dispatch({ type: 'send', prompt: 'write a file' });
    assert.equal(
      results[0]?.is_error,
      true,
      'session A must retain read-only after session B was selected',
    );
    await carrier.dispatch({ type: 'load', id: b });
    await carrier.dispatch({ type: 'send', prompt: 'write a file' });
    assert.equal(results[1]?.is_error, false, 'session B must retain workspace-write');
  },
);

/**
 * A Host that is only what the cross-version policy and external-deletion cases need.
 *
 * The capability and the reply are the subject here, so the Host has to be able to be *older* than this
 * carrier: it advertises `execution-policy-files-network-v1` only when told to, and answers `sandbox.set` with
 * the mode alone when it does not — which is what a Host that ignores `files`/`network` really does. It is a
 * real child process over the same stdio/JSONL seam the desktop uses, because "a Host from before the
 * capability" and "a session another client deleted" are facts about a process and its store, not branches in
 * a stub. Its sessions and its reply style live in a file the test rewrites, so a deletion can happen while
 * the Host is down.
 */
const FAKE_HOST = `
const fs = require('node:fs');

const root = process.cwd();
const statePath = process.env.FAKE_HOST_STATE;
const logPath = process.env.FAKE_HOST_LOG;
const strict = process.env.FAKE_HOST_STRICT === '1';
const capabilities = ['runtime.ready', 'sessions', 'session-management', 'streaming', 'message-turns', 'approval', 'cancel', 'images', 'steer', 'follow-up', 'context-summary', 'resources', 'session-pages', 'tasks', 'task-attempts', 'task-verify', 'task-retry', 'background-jobs', 'plan-approval', 'subagents'];
if (strict) capabilities.push('execution-policy-files-network-v1');

function read() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    return { sessions: [], selections: {}, reply: 'echo' };
  }
}
function write(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function note(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n');
}
function known(id) {
  const found = (read().sessions || []).find(function (session) { return session.id === id; });
  if (!found) throw new Error('Unknown session: ' + id);
  return found;
}
function sandboxSet(params) {
  note({ method: 'sandbox.set', params: params });
  const state = read();
  if (state.deleteOnSandbox) {
    state.sessions = state.sessions.filter(function (session) { return session.id !== state.deleteOnSandbox; });
    delete state.deleteOnSandbox;
    write(state);
  }
  if (state.sandboxError) throw new Error(state.sandboxError);
  if (params.sessionId !== undefined) known(params.sessionId);
  const key = params.sessionId === undefined ? '' : params.sessionId;
  const previous = (state.selections || {})[key] || {};
  const applied = {
    mode: params.mode,
    files: params.files === undefined ? previous.files : params.files,
    network: params.network === undefined ? previous.network : params.network,
  };
  state.selections = state.selections || {};
  state.selections[key] = applied;
  write(state);
  if (!strict) return { mode: params.mode };
  if (state.reply === 'mismatch') return { mode: params.mode, files: 'workspace-write' };
  const answer = { mode: params.mode };
  if (applied.files !== undefined) answer.files = applied.files;
  if (applied.network !== undefined) answer.network = applied.network;
  return answer;
}
let created = 0;
function dispatch(method, params) {
  switch (method) {
    case 'host.info':
      return { protocolVersion: 1, runtime: 'yuantu', workspace: root, capabilities: capabilities };
    case 'session.list':
      return read().sessions || [];
    case 'session.create': {
      created += 1;
      const state = read();
      const session = { id: 'session-new-' + process.pid + '-' + created, title: 'New session', workspace: root, createdAt: new Date().toISOString(), activeRun: null };
      state.sessions = (state.sessions || []).concat([session]);
      write(state);
      return session;
    }
    case 'session.get':
      known(params.sessionId);
      return { messages: [] };
    case 'changes.list':
      return [];
    case 'session.audit':
      return { entries: [], nextSeq: 0 };
    case 'task.list':
      return [];
    case 'background.list':
      return [];
    case 'background.state':
      return { policy: { mode: 'notify', paused: false, maxWakeups: 3, maxRunMs: 60000, epoch: 'fixture', used: 0 }, deliveries: [] };
    case 'resources.list':
      return { instructions: [], skills: [], extensions: [] };
    case 'runtime.ready':
      return { ready: true };
    case 'sandbox.set':
      return sandboxSet(params);
    case 'permission.update':
      return { applied: true, resolvedApprovals: 0 };
    default:
      throw new Error('Unsupported method: ' + method);
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let packet;
    try {
      packet = JSON.parse(line);
    } catch (error) {
      continue;
    }
    let answer;
    try {
      answer = { id: packet.id, result: dispatch(packet.method, packet.params || {}) };
    } catch (error) {
      answer = { id: packet.id, error: { message: error instanceof Error ? error.message : String(error), code: 'FAKE_HOST_ERROR' } };
    }
    process.stdout.write(JSON.stringify(answer) + '\\n');
  }
});
`;
interface FakeHostOptions {
  strict?: boolean;
  reply?: 'echo' | 'mismatch';
  sessions?: string[];
}
/** A controllable Host in a temp workspace, plus the handles a test needs to steer and read it. */
async function fakeHost(root: string, options: FakeHostOptions = {}) {
  const statePath = path.join(root, 'fake-host-state.json');
  const logPath = path.join(root, 'fake-host-requests.jsonl');
  const script = path.join(root, 'fake-host.cjs');
  const current = { sessions: options.sessions ?? [], reply: options.reply ?? 'echo' };
  const flush = () =>
    writeFile(
      statePath,
      JSON.stringify(
        {
          sessions: current.sessions.map((id) => ({
            id,
            title: id,
            workspace: root,
            createdAt: '2026-10-10T00:00:00.000Z',
            activeRun: null,
          })),
          selections: {},
          reply: current.reply,
        },
        null,
        2,
      ),
    );
  await writeFile(script, FAKE_HOST);
  await writeFile(logPath, '');
  await flush();
  const requests = async (): Promise<Array<{ method: string; params: Record<string, unknown> }>> =>
    (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  return {
    script,
    env: {
      FAKE_HOST_STATE: statePath,
      FAKE_HOST_LOG: logPath,
      FAKE_HOST_STRICT: options.strict ? '1' : '0',
    },
    requests,
    /** What another client's deletion looks like to a Host: the session is no longer in its list. */
    setSessions: async (sessions: string[]) => {
      current.sessions = sessions;
      await flush();
    },
    setReply: async (reply: 'echo' | 'mismatch') => {
      current.reply = reply;
      await flush();
    },
    failReplay: async (change: { deleteOnSandbox?: string; sandboxError?: string }) => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      await writeFile(statePath, JSON.stringify({ ...state, ...change }));
    },
  };
}

for (const failure of ['deleted', 'policy'] as const) {
  test(
    `recovery distinguishes ${failure} failure after listing sessions`,
    { timeout: 30_000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'yuantu-recovery-race-'));
      const host = await fakeHost(root, { strict: true, sessions: ['session-a'] });
      const carrier = spawnedCarrier({
        nodePath: process.execPath,
        hostPath: host.script,
        workspace: root,
        env: host.env,
      });
      t.after(async () => {
        await carrier.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      });
      await carrier.start();
      await carrier.dispatch({
        type: 'sandbox',
        mode: 'host',
        files: 'read-only',
        network: 'denied',
      });
      await host.failReplay(
        failure === 'deleted'
          ? { deleteOnSandbox: 'session-a' }
          : { sandboxError: 'active policy refused' },
      );
      const pid = carrier.snapshot.hostPid!;
      process.kill(pid, 'SIGKILL');
      await waitFor(
        () =>
          (carrier.snapshot.ready &&
            carrier.snapshot.hostPid !== pid &&
            carrier.snapshot.recovery !== null) ||
          carrier.snapshot.startupStage === 'failed',
        'recovery after a replay race',
      );
      if (failure === 'deleted') {
        assert.equal(carrier.snapshot.ready, true, carrier.snapshot.error ?? '');
        assert.equal(
          carrier.snapshot.recovery?.attempts,
          2,
          'the next attempt re-lists and discards the deleted selection',
        );
        assert.notEqual(carrier.snapshot.session.sessionId, 'session-a');
      } else {
        assert.equal(
          carrier.snapshot.ready,
          false,
          'a live session policy failure must block readiness',
        );
        assert.match(carrier.snapshot.error ?? '', /active policy refused/);
        await assert.rejects(carrier.dispatch({ type: 'send', prompt: 'must not execute' }));
      }
    },
  );
}

test(
  'a Host that cannot acknowledge files and network never has a restrictive policy cached',
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-legacy-policy-'));
    const host = await fakeHost(root, { strict: false, sessions: ['session-a'] });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: host.script,
      workspace: root,
      env: host.env,
    });
    t.after(async () => {
      await carrier.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await carrier.start();
    assert.equal(carrier.snapshot.session.sessionId, 'session-a');
    const sent = async () =>
      (await host.requests()).filter((entry) => entry.method === 'sandbox.set');
    // A mode-only choice is all a Host from before the capability can confirm, and that keeps working.
    await carrier.dispatch({ type: 'sandbox', mode: 'host' });
    assert.equal((await sent()).length, 1);
    // A restrictive selection is refused *before* it is sent: this Host would answer the mode alone, and the
    // carrier must not turn that into "read-only is in force".
    await assert.rejects(
      carrier.dispatch({
        type: 'sandbox',
        mode: 'seatbelt',
        files: 'read-only',
        network: 'denied',
      }),
      /execution-policy-files-network-v1/,
    );
    assert.equal(
      (await sent()).length,
      1,
      'a Host that ignores the fields is never asked for them',
    );
    // And nothing unconfirmed is cached: the restart replays what the Host actually confirmed, and nothing else.
    const pid = carrier.snapshot.hostPid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () =>
        carrier.snapshot.ready &&
        carrier.snapshot.hostPid !== pid &&
        carrier.snapshot.recovery !== null,
      'recovery after a refused strict policy',
    );
    const replays = await sent();
    assert.equal(replays.length, 2);
    assert.equal(replays[1]!.params.mode, 'host');
    assert.equal('files' in replays[1]!.params, false);
    assert.equal('network' in replays[1]!.params, false);
  },
);

test(
  'a Host that answers a different policy leaves the selection unconfirmed and stops execution',
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-policy-mismatch-'));
    const host = await fakeHost(root, { strict: true, sessions: ['session-a'] });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: host.script,
      workspace: root,
      env: host.env,
    });
    t.after(async () => {
      await carrier.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await carrier.start();
    // A Host that does acknowledge the fields is believed, and this is the state everything below departs from.
    await carrier.dispatch({ type: 'sandbox', mode: 'host', files: 'workspace-write' });
    await host.setReply('mismatch');
    await assert.rejects(
      carrier.dispatch({ type: 'sandbox', mode: 'seatbelt', files: 'read-only' }),
      { code: 'policyMismatch' },
    );
    // The Host may have applied part of it, so work is refused rather than run under a policy nobody can name.
    await assert.rejects(carrier.dispatch({ type: 'taskVerify', taskId: 'task-1' }), {
      code: 'policyUnconfirmed',
    });
    await host.setReply('echo');
    await carrier.dispatch({ type: 'sandbox', mode: 'host', files: 'read-only' });
    // A confirmed selection clears the state, so the same command reaches the Host again.
    await assert.rejects(
      carrier.dispatch({ type: 'taskVerify', taskId: 'task-1' }),
      (error: unknown) => {
        assert.notEqual((error as { code?: string }).code, 'policyUnconfirmed');
        return true;
      },
    );
  },
);

test(
  'recovery drops a sandbox selection whose session another client deleted',
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-deleted-session-'));
    const host = await fakeHost(root, { strict: true, sessions: ['session-a', 'session-b'] });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: host.script,
      workspace: root,
      env: host.env,
    });
    t.after(async () => {
      await carrier.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await carrier.start();
    // Two sessions with two different strict policies, which is what makes a wrong replay visible.
    await carrier.dispatch({
      type: 'sandbox',
      mode: 'seatbelt',
      files: 'read-only',
      network: 'denied',
    });
    await carrier.dispatch({ type: 'load', id: 'session-b' });
    await carrier.dispatch({
      type: 'sandbox',
      mode: 'host',
      files: 'workspace-write',
      network: 'unrestricted',
    });
    await carrier.dispatch({ type: 'load', id: 'session-a' });
    const before = (await host.requests()).length;
    // Another client deletes B while this carrier is down. Its cached selection is now about a session that
    // does not exist, and replaying it used to fail every recovery attempt.
    await host.setSessions(['session-a']);
    const pid = carrier.snapshot.hostPid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () =>
        (carrier.snapshot.ready &&
          carrier.snapshot.hostPid !== pid &&
          carrier.snapshot.recovery !== null) ||
        carrier.snapshot.startupStage === 'failed',
      'recovery with an externally deleted session',
    );
    assert.equal(
      carrier.snapshot.ready,
      true,
      `recovery must survive an externally deleted session: ${carrier.snapshot.error ?? ''}`,
    );
    assert.equal(
      carrier.snapshot.recovery?.attempts,
      1,
      'the deleted session must not cost an attempt',
    );
    const replays = (await host.requests())
      .slice(before)
      .filter((entry) => entry.method === 'sandbox.set');
    assert.deepEqual(
      replays.map((entry) => entry.params.sessionId),
      ['session-a'],
      'only the session that still exists is replayed',
    );
    assert.equal(
      replays[0]!.params.files,
      'read-only',
      "A's policy must not be widened by the recovery",
    );
    assert.equal(replays[0]!.params.network, 'denied');
  },
);

test(
  'recovery starts over when the session it had open was deleted too',
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-deleted-open-'));
    const host = await fakeHost(root, { strict: true, sessions: ['session-a'] });
    const carrier = spawnedCarrier({
      nodePath: process.execPath,
      hostPath: host.script,
      workspace: root,
      env: host.env,
    });
    t.after(async () => {
      await carrier.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await carrier.start();
    await carrier.dispatch({ type: 'sandbox', mode: 'seatbelt', files: 'read-only' });
    const before = (await host.requests()).length;
    await host.setSessions([]);
    const pid = carrier.snapshot.hostPid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(
      () =>
        (carrier.snapshot.ready &&
          carrier.snapshot.hostPid !== pid &&
          carrier.snapshot.recovery !== null) ||
        carrier.snapshot.startupStage === 'failed',
      'recovery with no sessions left',
    );
    assert.equal(
      carrier.snapshot.ready,
      true,
      `recovery must fall back to a new session: ${carrier.snapshot.error ?? ''}`,
    );
    assert.equal(carrier.snapshot.recovery?.attempts, 1);
    const replayed = (await host.requests())
      .slice(before)
      .filter((entry) => entry.method === 'sandbox.set');
    assert.deepEqual(replayed, [], 'a deleted session is never retried');
    assert.notEqual(carrier.snapshot.session.sessionId, 'session-a');
  },
);

test('one parser validates the vocabulary every carrier sends', () => {
  assert.deepEqual(parseCarrierCommand({ type: 'sandbox', mode: 'native', files: 'read-only' }), {
    type: 'sandbox',
    mode: 'native',
    files: 'read-only',
  });
  assert.throws(
    () => parseCarrierCommand({ type: 'sandbox', mode: 'native', files: 'invalid' }),
    /Invalid carrier command/,
  );
  assert.deepEqual(parseCarrierCommand({ type: 'cancel' }), { type: 'cancel' });
  assert.deepEqual(parseCarrierCommand({ type: 'copyText', text: 'hi' }), {
    type: 'copyText',
    text: 'hi',
  });
  assert.throws(() => parseCarrierCommand({ type: 'exec', command: 'rm -rf /' }), {
    message: 'Invalid carrier command',
  });
});
