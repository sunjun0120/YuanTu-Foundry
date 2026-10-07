import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { AgentEvent, Message } from '../packages/protocol/index.ts';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { isSummaryBody } from './summary-request.ts';
import { projectRoot } from './process-fixture.ts';

// ---- merged from host-workflows.test.ts ----

// These scripted endpoints verify actual Host/file/history behavior. They do not
// assess a live model's ability to summarize, accept steering, or recover.
const hostPath = path.resolve('apps/agent-host/main.ts');
async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-host-workflow-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  (t as test.TestContext & { workflowCleanups: typeof cleanups }).workflowCleanups = cleanups;
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'theme.txt'), 'red\n');
  return root;
}
/**
 * Wait for the pid file a freshly started command writes, and answer the number in it.
 *
 * The wait is for a *process*, not for the runtime: on Windows a sandbox wrapper and a Node startup sit
 * between "spawned" and "wrote its pid", which is why the two cancellation fixtures here cannot read the file
 * immediately (ENOENT). The budget has to survive the machine the gate runs on rather than the quiet one this
 * was tuned against: at three seconds this fixture failed in two consecutive full-suite runs (4.9 s, 5.1 s)
 * while passing on its own every time, which is a false negative *about the product* — the command does start,
 * only later than the poll allowed. Fifteen seconds is a budget rather than a timing claim: a command that
 * never starts still fails here, and the assertion each caller makes afterwards — that this process was killed
 * — is the one that means something.
 */
async function commandPid(file: string, what: string): Promise<number> {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const pid = Number(await readFile(file, 'utf8'));
      if (pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not write ${path.basename(file)} within 15s`);
}
function clientFor(root: string, url: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_SESSION_TITLES: '0',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'workflow-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_BASE_URL: url,
      /**
       * A window for the fixture endpoint, because a run without one is refused.
       *
       * The window is the only ceiling a run has, and `declaredCapacity` refuses to invent one — the same
       * refusal `tests/process-fixture.ts` declares this number for. A fixture that needs its own numbers
       * for the compaction arithmetic overrides it through `extraEnv`.
       */
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      ...extraEnv,
    },
  });
}

test('Host restart exposes interrupted child and a paged synthetic long session', async (t) => {
  const root = await workspace(t);
  const dbPath = path.join(root, 'sessions.sqlite');
  const seed = new SessionStore(dbPath);
  const parent = seed.create(root);
  for (let index = 0; index < 150; index++) {
    seed.append(parent.id, { role: 'user', content: 'request ' + index });
    seed.append(parent.id, { role: 'assistant', content: 'answer ' + index, toolCalls: [] });
  }
  const child = seed.create(root, parent.id);
  // What the provider records when it starts a child: the card's identity is a durable fact in the
  // parent's log, so no separate table is needed to restore it.
  seed.recordEvent(parent.id, 'subagent.assigned', {
    id: 'interrupted-1',
    role: 'explore',
    objective: 'Inspect a large project',
    childSessionId: child.id,
  });
  seed.append(child.id, {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'pending-1', name: 'read_file', arguments: { path: 'theme.txt' } }],
  });
  seed.close();
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
  ).run('crashed-child', child.id, 2147483647, new Date().toISOString());
  db.prepare('UPDATE sessions SET active_run=? WHERE id=?').run('crashed-child', child.id);
  db.close();

  const client = clientFor(root, 'http://127.0.0.1:1');
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  await client.start();
  const cards = await client.request('subagents.list', { sessionId: parent.id });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.status, 'interrupted');
  assert.equal(cards[0]?.sessionId, child.id);
  const childHistory = await client.request('session.get', { sessionId: child.id });
  assert.match(String(childHistory.messages.at(-1)?.content), /Execution outcome is unknown/);
  const messages = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page: { messages: Message[]; nextOffset?: number } = await client.request('session.get', {
      sessionId: parent.id,
      offset,
    });
    messages.push(...page.messages);
    offset = page.nextOffset;
  }
  assert.equal(messages.length, 300);
  assert.equal(messages.at(-1)?.content, 'answer 149');
});
test('Host workflow preserves summary constraints in repaired files and full history after Host reload', async (t) => {
  const root = await workspace(t);
  const db = path.join(root, 'sessions.sqlite');
  const seed = new SessionStore(db);
  const session = seed.create(root);
  for (let index = 0; index < 3; index++) {
    seed.append(session.id, {
      role: 'user',
      content: 'Keep theme blue. ' + 'prior detail '.repeat(3200),
    });
    seed.append(session.id, { role: 'assistant', content: 'Preserve blue.', toolCalls: [] });
  }
  const originalHistory = seed.messages(session.id);
  seed.close();
  let summaries = 0,
    turns = 0;
  const url = await httpFixture(t, (body, res) => {
    // Recognised by the one place that owns the question (`tests/summary-request.ts`): the instruction rides as
    // the request's last message, so a fixture reading the system prompt for it would silently stop matching
    // and let the summary branch never run.
    if (isSummaryBody(body)) {
      summaries++;
      sendFrames(res, frames('User constraint: keep theme blue. theme.txt still needs repair.'));
      return;
    }
    // The retained constraint reaches the round as the summary at the front of the conversation — the prompt is
    // the caller's own and a compaction does not rewrite it, which is what keeps the provider's cache entry
    // (system prompt and tool catalogue) usable across one.
    assert.match(JSON.stringify(body.messages), /keep theme blue/);
    assert.doesNotMatch(systemText(body.system), /<compacted-summary>|<conversation_summary>/);
    /**
     * The scripted model reads before it edits, because the product requires it to.
     *
     * The read-before-write gate refuses a change prepared from a file this run has not read, and it runs
     * *before* the approval prompt (`packages/tools/fs-observation.ts`), so a scripted blind edit is refused
     * without ever asking for approval and the run then completes with the file untouched.
     */
    sendFrames(
      res,
      turns++ === 0
        ? frames('', [{ id: 'read-theme', name: 'read_file', input: { path: 'theme.txt' } }])
        : turns === 2
          ? frames('', [
              {
                id: 'repair',
                name: 'edit_file',
                input: { path: 'theme.txt', old_text: 'red\n', new_text: 'blue\n' },
              },
            ])
          : frames('Applied the retained theme constraint.'),
    );
  });
  /**
   * The window this fixture compacts under, and the arithmetic the two numbers below are chosen from.
   *
   * `resolveCompactionSpec` resolves **no proactive policy at all** unless the window can carry this
   * request's output reservation plus 65,536 tokens of headroom, so the old 24,000 did not compact "too
   * eagerly" — it never resolved a policy, and compaction was left to the request that stops fitting. The
   * summary request meanwhile has to carry the main system prompt, the whole tool catalogue (this Host sends
   * 80 schemas, ~55 KB) *and* the batch inside the window, so at 24,000 the fixed ~19.3 K tokens left no
   * room for a single ~41.6 KB pair and every batch was refused. With 128,000 declared: the threshold is
   * min(0.8 × 128,000, 128,000 − 4,096 − 65,536) = 58,368 tokens, retention keeps 16% of 123,904 = 19,824
   * tokens verbatim, the three seeded pairs put the round at ~61 K estimated tokens (above the threshold,
   * still inside the window), and a batch plus the fixed part fits with room to spare.
   */
  const client = clientFor(root, url, {
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_MAX_OUTPUT_TOKENS: '4096',
  });
  const events: AgentEvent[] = [];
  const approvals: Promise<unknown>[] = [];
  client.subscribe((event) => {
    events.push(event);
    if (event.type === 'approval.required')
      approvals.push(
        client.request('approval.respond', {
          approvalId: String(event.data.approvalId),
          allow: true,
        }),
      );
  });
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  await client.start();
  const result = await client.run(
    session.id,
    'Apply the theme constraint from our prior discussion.',
  );
  await Promise.all(approvals);
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries > 0);
  assert.ok(events.some((event) => event.type === 'context.compacted'));
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'blue\n');
  const history = (await client.request('session.get', { sessionId: session.id })).messages;
  assert.deepEqual(history.slice(0, originalHistory.length), originalHistory);
  await client.stop();
  await client.start();
  assert.deepEqual(
    (await client.request('session.get', { sessionId: session.id })).messages,
    history,
  );
  await client.stop();
  const persisted = new SessionStore(db);
  try {
    // The surface is folded from the log (`context.compacted`), not read from a table: schema v18 deleted
    // `context_checkpoints` precisely because a compaction that lives only in a row can disagree with the log.
    const surface = persisted.contextSurface(session.id);
    assert.match(surface!.summary, /keep theme blue/);
    // Two, not six: retention keeps the newest 19,824 tokens verbatim, which is the newest two seeded pairs
    // plus the turn being sent, so the surface covers the oldest pair. The six-message history is still in
    // the log (`history` above) — a compaction replaces a *view*, never the transcript.
    assert.equal(surface!.coveredMessages, 2);
    assert.equal(persisted.get(session.id).activeRun, null);
  } finally {
    persisted.close();
  }
});

test('Host workflow steering blocks stale writes and persists the correction after Host reload', async (t) => {
  const root = await workspace(t);
  let turns = 0;
  const correction = 'Keep the file unchanged; explain only.';
  const url = await httpFixture(t, (body, res) => {
    /**
     * The read comes first so that the steer is the only thing that can block the two writes.
     *
     * Without it the read-before-write gate refuses `stale-one` before its approval prompt (no approval, no
     * person involved), and this test's count of blocked writes would then be one gate refusal plus one
     * pending call — evidence about the gate, not about steering. With the read recorded both writes are
     * approvable, and the only thing that stops them is the instruction that supersedes them.
     */
    if (turns++ === 0)
      sendFrames(
        res,
        frames('', [{ id: 'read-before-writes', name: 'read_file', input: { path: 'theme.txt' } }]),
      );
    else if (turns === 2)
      sendFrames(
        res,
        frames('', [
          {
            id: 'stale-one',
            name: 'edit_file',
            input: { path: 'theme.txt', old_text: 'red\n', new_text: 'blue\n' },
          },
          {
            id: 'stale-two',
            name: 'write_file',
            input: { path: 'unexpected.txt', content: 'stale' },
          },
        ]),
      );
    else {
      assert.match(JSON.stringify(body.messages), /Keep the file unchanged; explain only/);
      sendFrames(res, frames('Explained without changes.'));
    }
  });
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  let ready!: () => void;
  const pendingApproval = new Promise<void>((resolve) => {
    ready = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'approval.required') ready();
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Make both changes.');
  await pendingApproval;
  await client.request('run.enqueue', { sessionId: session.id, mode: 'steer', prompt: correction });
  const result = await running;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'red\n');
  await assert.rejects(readFile(path.join(root, 'unexpected.txt')), { code: 'ENOENT' });
  const history = (await client.request('session.get', { sessionId: session.id })).messages;
  assert.ok(history.some((message) => message.role === 'user' && message.content === correction));
  assert.equal(history.filter((message) => message.role === 'tool' && message.isError).length, 2);
  await client.stop();
  await client.start();
  assert.deepEqual(
    (await client.request('session.get', { sessionId: session.id })).messages,
    history,
  );
});

test('Host workflow interrupted Host recovery records uncertainty and inspects files before continuing', async (t) => {
  const root = await workspace(t);
  const db = path.join(root, 'sessions.sqlite');
  let turns = 0;
  // The scripted model reads before it edits: the read-before-write gate refuses a change prepared from a file
  // this run has not read, and it runs *before* the approval prompt — so a blind edit is refused without asking
  // for approval, and the approval this test waits for (to kill the Host mid-change) could never arrive.
  const url = await httpFixture(t, (body, res) => {
    const step = turns++;
    if (step === 0)
      sendFrames(
        res,
        frames('', [{ id: 'inspect-theme', name: 'read_file', input: { path: 'theme.txt' } }]),
      );
    else if (step === 1)
      sendFrames(
        res,
        frames('', [
          {
            id: 'interrupted-edit',
            name: 'edit_file',
            input: { path: 'theme.txt', old_text: 'red\n', new_text: 'blue\n' },
          },
        ]),
      );
    else if (step === 2) {
      assert.match(JSON.stringify(body.messages), /Execution outcome is unknown/);
      sendFrames(
        res,
        frames('', [{ id: 'inspect', name: 'read_file', input: { path: 'theme.txt' } }]),
      );
    } else {
      assert.match(JSON.stringify(body.messages), /red/);
      sendFrames(res, frames('Inspected current file; no write was replayed.'));
    }
  });
  const child = spawn(process.execPath, [hostPath, '--workspace', root, '--db', db], {
    cwd: root,
    env: {
      YUANTU_SESSION_TITLES: '0',
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      NODE_OPTIONS: '',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_BASE_URL: url,
      // A refused run never reaches an approval, so the run needs a declared window like every other fixture.
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const lines = createInterface({ input: child.stdout });
  let sessionId = '';
  let refusal = '';
  /**
   * Settled by the approval this test drives, and failed by anything that means it can never arrive.
   *
   * The kill timer below stops the process but settles nothing, so a Host that never asks for approval — the
   * refusal an undeclared context window produces, for one — used to leave `await pending` waiting forever
   * and the whole file with it. A fixture that needs a live approval has to fail on the refusal instead.
   */
  const pending = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () =>
      reject(
        new Error(
          `Host exited before requesting approval${refusal ? `: ${refusal}` : ''}` +
            `${stderr.trim() ? ` (stderr: ${stderr.trim()})` : ''}`,
        ),
      ),
    );
    lines.on('line', (line) => {
      const frame = JSON.parse(line);
      if (frame.id === 'create') {
        if (frame.error) {
          reject(new Error(frame.error.message));
          return;
        }
        sessionId = frame.result.id;
        child.stdin.write(
          JSON.stringify({
            id: 'run',
            method: 'run.start',
            params: { sessionId, prompt: 'Change theme.' },
          }) + '\n',
        );
      }
      if (frame.id === 'run' && frame.error) refusal = String(frame.error.message);
      if (frame.event?.type === 'approval.required') resolve();
    });
  });
  child.stdin.write(JSON.stringify({ id: 'create', method: 'session.create', params: {} }) + '\n');
  const timer = setTimeout(() => child.kill(), 10_000);
  t.after(() => clearTimeout(timer));
  await pending;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
  clearTimeout(timer);
  lines.close();
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'red\n');
  const crashed = new SessionStore(db);
  try {
    assert.ok(crashed.get(sessionId).activeRun);
  } finally {
    crashed.close();
  }
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  await client.start();
  const result = await client.run(
    sessionId,
    'Inspect current state before continuing; do not replay writes.',
  );
  assert.equal(result.status, 'completed', result.error);
  const history = (await client.request('session.get', { sessionId })).messages;
  const uncertainty = history.find(
    (message) => message.role === 'tool' && message.toolCallId === 'interrupted-edit',
  );
  assert.ok(uncertainty?.role === 'tool' && uncertainty.isError);
  assert.match(uncertainty.content, /Execution outcome is unknown/);
  assert.ok(
    history.some(
      (message) => message.role === 'tool' && message.toolCallId === 'inspect' && !message.isError,
    ),
  );
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'red\n');
  assert.equal((await client.request('session.get', { sessionId })).session.activeRun, null);
  await client.stop();
  await client.start();
  assert.deepEqual((await client.request('session.get', { sessionId })).messages, history);
});

test('Host recovers after a real journaled write without replaying its file effect', async (t) => {
  const root = await workspace(t),
    db = path.join(root, 'sessions.sqlite');
  const child = spawn(process.execPath, [path.resolve('tests/effect-crash-worker.ts'), db, root], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 73, stderr);
  const sessionId = stdout.trim();
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'blue\n');
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0) {
      assert.match(JSON.stringify(body.messages), /Execution outcome is unknown/);
      sendFrames(
        res,
        frames('', [{ id: 'inspect-effect', name: 'read_file', input: { path: 'theme.txt' } }]),
      );
    } else {
      assert.match(JSON.stringify(body.messages), /blue/);
      sendFrames(res, frames('Verified the prior write remains applied.'));
    }
  });
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  let approvals = 0;
  client.subscribe((event) => {
    if (event.type === 'approval.required') {
      approvals++;
      void client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: false,
      });
    }
  });
  await client.start();
  const result = await client.run(
    sessionId,
    'Read the actual state before continuing. Do not write again.',
  );
  assert.equal(result.status, 'completed', result.error);
  assert.equal(approvals, 0);
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'blue\n');
  const changes = await client.request('changes.list', { sessionId });
  assert.equal(changes.length, 1, 'no duplicate file journal entry');
  const snapshot = await client.request('session.get', { sessionId });
  assert.equal(snapshot.session.activeRun, null);
  assert.ok(
    snapshot.messages.some(
      (m) => m.role === 'tool' && m.toolCallId === 'effect-before-crash' && m.isError,
    ),
  );
  assert.ok(
    snapshot.messages.some(
      (m) => m.role === 'tool' && m.toolCallId === 'inspect-effect' && !m.isError,
    ),
  );
  await client.stop();
  await client.start();
  assert.deepEqual(
    (await client.request('session.get', { sessionId })).messages,
    snapshot.messages,
  );
});

test('Host cancellation after command effects kills the command and retains uncertainty across reload', async (t) => {
  const root = await workspace(t);
  await writeFile(
    path.join(root, 'wait.cjs'),
    'require("fs").appendFileSync("effect.txt","once\\n");require("fs").writeFileSync("pid.txt",String(process.pid));setInterval(()=>{},1000)',
  );
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0)
      sendFrames(
        res,
        frames('', [
          { id: 'active-command', name: 'run_command', input: { command: 'node wait.cjs' } },
        ]),
      );
    else if (turns === 2) {
      assert.match(JSON.stringify(body.messages), /may already have had effects/);
      sendFrames(
        res,
        frames('', [{ id: 'inspect-command', name: 'read_file', input: { path: 'effect.txt' } }]),
      );
    } else sendFrames(res, frames('Inspected the completed effect; no command replay.'));
  });
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  const approvals: Promise<unknown>[] = [];
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      approvals.push(
        client.request('approval.respond', {
          approvalId: String(event.data.approvalId),
          allow: true,
        }),
      );
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Run the foreground command.');
  const pid = await commandPid(path.join(root, 'pid.txt'), 'the foreground command');
  await client.request('run.cancel', { sessionId: session.id });
  assert.equal((await running).status, 'cancelled');
  await Promise.all(approvals);
  assert.throws(() => process.kill(pid, 0), 'command process must be stopped');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'once\n');
  assert.equal(
    (await client.request('session.get', { sessionId: session.id })).session.activeRun,
    null,
  );
  await client.stop();
  await client.start();
  const recovered = await client.run(
    session.id,
    'Inspect actual effects only; never rerun the command.',
  );
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'once\n');
});

test('Host model retry after a successful edit does not repeat the edit or its approval', async (t) => {
  const root = await workspace(t);
  let requests = 0;
  const url = await httpFixture(t, (_, res) => {
    requests++;
    /**
     * The round that reads comes first, because the read-before-write gate refuses an edit prepared from a
     * file this run has not read — and refuses it *before* the approval prompt, so a blind edit would be a
     * tool error with no approval at all, and this test would then be measuring the gate instead of the
     * retry. The edit round is the one the next response refuses with a transient 503: what the retry must
     * not do is run that round's tool call (or ask for its approval) a second time.
     */
    if (requests === 1)
      sendFrames(
        res,
        frames('', [{ id: 'read-before-edit', name: 'read_file', input: { path: 'theme.txt' } }]),
      );
    else if (requests === 2)
      sendFrames(
        res,
        frames('', [
          {
            id: 'edit-before-retry',
            name: 'edit_file',
            input: { path: 'theme.txt', old_text: 'red\n', new_text: 'blue\n' },
          },
        ]),
      );
    else if (requests === 3) {
      res.writeHead(503, { 'retry-after': '0' });
      res.end();
    } else sendFrames(res, frames('Done after transient model error.'));
  });
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  const approvals: Promise<unknown>[] = [];
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      approvals.push(
        client.request('approval.respond', {
          approvalId: String(event.data.approvalId),
          allow: true,
        }),
      );
  });
  await client.start();
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Change red to blue.');
  await Promise.all(approvals);
  assert.equal(result.status, 'completed', result.error);
  // Four: the read round, the edit round, the round the 503 refuses and the retry that answers it. One
  // approval and one journaled change across all of them is what says the retry did not repeat round two.
  assert.equal(requests, 4);
  assert.equal(approvals.length, 1);
  assert.equal((await client.request('changes.list', { sessionId: session.id })).length, 1);
  assert.equal(await readFile(path.join(root, 'theme.txt'), 'utf8'), 'blue\n');
});

test('Host MCP approval precedes stdio startup and closes the server before run completion', async (t) => {
  const root = await workspace(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(
    path.join(root, '.yuantu/mcp.json'),
    JSON.stringify({
      servers: {
        local: {
          transport: 'stdio',
          command: process.execPath,
          args: [path.resolve('tests/mcp-fixture.ts'), 'mcp-pid.txt'],
        },
      },
    }),
  );
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0)
      sendFrames(
        res,
        frames('', [
          {
            id: 'external',
            name: 'mcp_local_call_tool',
            input: { name: 'echo', arguments: { text: 'Host MCP result' } },
          },
        ]),
      );
    else {
      assert.match(JSON.stringify(body.messages), /Host MCP result/);
      sendFrames(res, frames('External tool completed.'));
    }
  });
  /**
   * A stdio MCP server is a native child, and the confined default mode on Windows refuses exactly that
   * (`packages/mcp/tools.ts`: "native processes are blocked while YUANTU_SANDBOX=windows"). The fixture's
   * subject *is* that child, so it declares the mode that can run one — as an operator with a stdio server
   * must — instead of measuring the refusal and then looking for a process that was never allowed to start.
   */
  const client = clientFor(root, url, { YUANTU_SANDBOX: 'host' });
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  const approvals: Promise<unknown>[] = [];
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      approvals.push(
        (async () => {
          const approval = event.data.approval as { kind: string };
          assert.equal(approval.kind, 'external');
          await assert.rejects(readFile(path.join(root, 'mcp-pid.txt')), { code: 'ENOENT' });
          await client.request('approval.respond', {
            approvalId: String(event.data.approvalId),
            allow: true,
          });
        })(),
      );
  });
  await client.start();
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Use the configured external echo tool.');
  await Promise.all(approvals);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(approvals.length, 1);
  const pid = Number(await readFile(path.join(root, 'mcp-pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0));
  const snapshot = await client.request('session.get', { sessionId: session.id });
  assert.equal(snapshot.session.activeRun, null);
  await client.stop();
  await client.start();
  assert.deepEqual(
    (await client.request('session.get', { sessionId: session.id })).messages,
    snapshot.messages,
  );
});

test('Host keeps background jobs across turns and stops them on session cancellation', async (t) => {
  const root = await workspace(t);
  await writeFile(
    path.join(root, 'managed.cjs'),
    'require("fs").writeFileSync("managed.pid",String(process.pid));console.log("READY");setInterval(()=>{},1000);',
  );
  let turn = 0,
    jobId = '';
  const url = await httpFixture(t, (_body, res) => {
    const step = turn++;
    if (step === 0)
      sendFrames(
        res,
        frames('', [
          { id: 'start-job', name: 'start_command', input: { command: 'node managed.cjs' } },
        ]),
      );
    else if (step === 2)
      sendFrames(
        res,
        frames('', [{ id: 'poll-job', name: 'job_output', input: { id: jobId, wait_ms: 100 } }]),
      );
    else sendFrames(res, frames('Done.'));
  });
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      void client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: true,
      });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const first = await client.run(session.id, 'Start a managed command');
  assert.equal(first.status, 'completed', first.error);
  let history = (await client.request('session.get', { sessionId: session.id })).messages;
  const tool = history.find(
    (message) => message.role === 'tool' && message.toolCallId === 'start-job',
  );
  assert.ok(tool);
  jobId = JSON.parse(tool.content).id;
  const second = await client.run(session.id, 'Poll the running command');
  assert.equal(second.status, 'completed', second.error);
  history = (await client.request('session.get', { sessionId: session.id })).messages;
  const polled = history.find(
    (message) => message.role === 'tool' && message.toolCallId === 'poll-job',
  );
  assert.ok(polled);
  assert.equal(JSON.parse(polled.content).status, 'running');
  /**
   * Wait for the file the command writes when it starts, not for the job's status.
   *
   * `running` is true the moment the process is spawned, which on Windows is a sandbox wrapper and a Node
   * startup behind it, so reading the pid file immediately raced that (ENOENT). `commandPid` owns the budget
   * and the evidence for it.
   */
  const pid = await commandPid(path.join(root, 'managed.pid'), 'the managed command');
  await client.request('run.cancel', { sessionId: session.id });
  assert.throws(() => process.kill(pid, 0));
});

test('Host reserves session deletion while asynchronous background cleanup runs', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'managed.cjs'), 'setInterval(()=>{},1000);');
  let step = 0;
  const url = await httpFixture(t, (_body, res) =>
    sendFrames(
      res,
      step++ === 0
        ? frames('', [
            { id: 'start', name: 'start_command', input: { command: 'node managed.cjs' } },
          ])
        : frames('Done.'),
    ),
  );
  const client = clientFor(root, url);
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      void client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: true,
      });
  });
  await client.start();
  const session = await client.request('session.create', {});
  assert.equal((await client.run(session.id, 'start')).status, 'completed');
  const deleting = client.request('session.delete', { sessionId: session.id });
  await assert.rejects(client.run(session.id, 'overlapping run'), /busy|active run/i);
  assert.equal((await deleting).deleted, true);
});

test('Host permission policy stays fixed across runs after its source file changes', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'policy.json');
  await writeFile(
    file,
    JSON.stringify({ version: 1, rules: [{ effect: 'deny', kind: 'command' }] }),
  );
  await writeFile(
    path.join(root, 'effect.cjs'),
    'require("fs").writeFileSync("effect.txt","executed");',
  );
  let step = 0;
  const url = await httpFixture(t, (_body, res) =>
    sendFrames(
      res,
      step++ % 2 === 0
        ? frames('', [
            { id: 'effect-' + step, name: 'run_command', input: { command: 'node effect.cjs' } },
          ])
        : frames('Done.'),
    ),
  );
  const client = clientFor(root, url, { YUANTU_PERMISSION_POLICY: file });
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  let approvals = 0;
  client.subscribe((event) => {
    if (event.type === 'approval.required') {
      approvals++;
      void client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: true,
      });
    }
  });
  await client.start();
  const session = await client.request('session.create', {});
  assert.equal((await client.run(session.id, 'first')).status, 'completed');
  await writeFile(
    file,
    JSON.stringify({ version: 1, rules: [{ effect: 'allow', kind: 'command' }] }),
  );
  assert.equal((await client.run(session.id, 'second')).status, 'completed');
  assert.equal(approvals, 0);
  await assert.rejects(readFile(path.join(root, 'effect.txt')), { code: 'ENOENT' });
});

test('Host persists Responses continuation and replays it after process restart', async (t) => {
  const root = await workspace(t);
  let step = 0;
  const reasoning = {
    id: 'rs',
    type: 'reasoning',
    summary: [],
    encrypted_content: 'opaque-fixture',
  };
  const url = await httpFixture(t, (body, res, _headers, route) => {
    assert.equal(route, '/v1/responses');
    if (step > 0)
      assert.ok(
        body.input.some(
          (item: Record<string, unknown>) => item.encrypted_content === 'opaque-fixture',
        ),
      );
    const output =
      step++ === 0
        ? [
            reasoning,
            {
              type: 'function_call',
              id: 'fc',
              call_id: 'read',
              name: 'read_file',
              arguments: '{"path":"theme.txt"}',
            },
          ]
        : [
            {
              type: 'message',
              id: 'msg' + step,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Read theme.', annotations: [] }],
            },
          ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', output, usage: { input_tokens: 20, output_tokens: 10 } },
        }) +
        '\n\n',
    );
  });
  const client = clientFor(root, url, { YUANTU_PROTOCOL: 'openai-responses' });
  (t as test.TestContext & { workflowCleanups: (() => Promise<unknown>)[] }).workflowCleanups.push(
    () => client.stop(),
  );
  await client.start();
  const session = await client.request('session.create', {});
  assert.equal((await client.run(session.id, 'read')).status, 'completed');
  const history = (await client.request('session.get', { sessionId: session.id })).messages;
  assert.ok(
    history.some(
      (message) =>
        message.role === 'assistant' &&
        message.providerState?.output.some((item) => item.encrypted_content === 'opaque-fixture'),
    ),
  );
  await client.stop();
  await client.start();
  assert.equal((await client.run(session.id, 'continue')).status, 'completed');
});

// ---- merged from host.test.ts ----

test('JSONL Host accepts approvals, returns run results and cancels a streaming request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let step = 0;
  const url = await httpFixture(t, (_, res) => {
    if (step++ === 0)
      sendFrames(
        res,
        frames('', [
          { id: 'w', name: 'write_file', input: { path: 'approved.txt', content: 'ok' } },
        ]),
      );
    else if (step === 2) sendFrames(res, frames('Created'));
    else if (step === 3) sendFrames(res, frames('Retried'));
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
    }
  });
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'apps/agent-host/main.ts'), '--workspace', root],
    {
      cwd: projectRoot,
      env: {
        YUANTU_SESSION_TITLES: '0',
        ...process.env,
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_API_KEY: 'test',
        // A window, because a run without one is refused before it reaches a tool call.
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  let cancelOnStart = false;
  lines.on('line', (line) => {
    const data = JSON.parse(line);
    if (data.id) {
      const entry = pending.get(data.id);
      if (entry) {
        pending.delete(data.id);
        data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result);
      }
    }
    if (data.event?.type === 'approval.required' && data.event.data.approvalId)
      void rpc('approval.respond', { approvalId: data.event.data.approvalId, allow: true });
    if (cancelOnStart && data.event?.type === 'message.delta')
      assert.fail('waiting response should have no text');
    if (cancelOnStart && data.event?.type === 'run.started')
      void rpc('run.cancel', { sessionId: data.event.sessionId });
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`Host exited ${code}: ${stderr}`));
    pending.clear();
  });
  t.after(() => {
    lines.close();
    child.kill();
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  t.after(() => clearTimeout(timer));
  const info = await rpc('host.info');
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.runtime, 'yuantu');
  assert.equal(info.workspace, root);
  assert.ok(info.capabilities.includes('approval'));
  const session = await rpc('session.create');
  const task = await rpc('task.create', {
    sessionId: session.id,
    title: 'create approved file',
    acceptance: [
      {
        description: 'approved file contains expected content',
        met: false,
        check: { id: 'approved', kind: 'file-exact', path: 'approved.txt', expected: 'ok' },
      },
    ],
    steps: [{ description: 'write file', status: 'pending' }],
  });
  assert.equal((await rpc('task.list', { sessionId: session.id })).length, 1);
  const run = await rpc('run.start', {
    sessionId: session.id,
    taskId: task.id,
    prompt: 'create file',
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.acceptance.passed, true);
  const persistedTask = await rpc('task.get', { sessionId: session.id, taskId: task.id });
  assert.equal(persistedTask.status, 'completed');
  assert.equal(persistedTask.verification.passed, true);
  assert.equal(persistedTask.attemptCount, 1);
  await rm(path.join(root, 'approved.txt'));
  const failedVerify = await rpc('task.verify', { sessionId: session.id, taskId: task.id });
  assert.equal(failedVerify.task.status, 'needs_review');
  assert.equal(failedVerify.attempt.kind, 'verify');
  assert.equal(failedVerify.attempt.verification.passed, false);
  await writeFile(path.join(root, 'approved.txt'), 'ok');
  const passedVerify = await rpc('task.verify', { sessionId: session.id, taskId: task.id });
  assert.equal(passedVerify.task.status, 'completed');
  const retry = await rpc('task.retry', { sessionId: session.id, taskId: task.id });
  assert.equal(retry.status, 'completed');
  assert.notEqual(retry.runId, run.runId);
  const attempts = await rpc('task.attempts', { sessionId: session.id, taskId: task.id });
  assert.deepEqual(
    attempts.map((attempt: any) => [attempt.ordinal, attempt.kind, attempt.status]),
    [
      [1, 'run', 'completed'],
      [2, 'verify', 'needs_review'],
      [3, 'verify', 'completed'],
      [4, 'run', 'completed'],
    ],
  );
  assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'ok');
  const history = await rpc('session.get', { sessionId: session.id });
  assert.ok(history.messages.some((m: any) => m.role === 'tool' && !m.isError));
  cancelOnStart = true;
  const cancelled = await rpc('run.start', { sessionId: session.id, prompt: 'wait' });
  assert.equal(cancelled.status, 'cancelled');
  child.stdin.end();
  const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(exit, 0, stderr);
});

/**
 * Regression: the active-run guard was evaluated before `active.set`, with an awaited
 * reconcilePendingFileChanges() in between. Two dispatches read in the same tick therefore both
 * passed the guard, both began a run, and the loser's `finally` deleted the winner's entry —
 * after which run.cancel silently no-opped for a live run and further runs were admitted.
 */
test('a second concurrent run.start is rejected instead of starting a second run', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-host-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('done')));
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'apps/agent-host/main.ts'), '--workspace', root],
    {
      cwd: projectRoot,
      env: {
        YUANTU_SESSION_TITLES: '0',
        ...process.env,
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_API_KEY: 'test',
        // A window, because a run without one is refused before it reaches a tool call.
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const waiters = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const outcomes = new Map<string, { ok: boolean; value?: any; error?: Error }>();
  const settle = (id: string) =>
    new Promise<void>((resolve) => {
      waiters.set(id, {
        resolve: (value) => {
          outcomes.set(id, { ok: true, value });
          resolve();
        },
        reject: (error) => {
          outcomes.set(id, { ok: false, error });
          resolve();
        },
      });
    });
  let sequence = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++sequence);
      waiters.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  lines.on('line', (line) => {
    const data = JSON.parse(line);
    if (!data.id) return;
    const entry = waiters.get(data.id);
    if (!entry) return;
    waiters.delete(data.id);
    data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result);
  });
  child.on('exit', (code) => {
    for (const waiter of waiters.values())
      waiter.reject(new Error(`Host exited ${code}: ${stderr}`));
    waiters.clear();
  });
  t.after(() => {
    lines.close();
    child.kill();
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  t.after(() => clearTimeout(timer));

  await rpc('host.info');
  const session = await rpc('session.create');
  // Both dispatches leave in ONE stdin write so both lines are read in the same tick: the first
  // handler is suspended inside reconcilePendingFileChanges() when the second checks the guard.
  const first = settle('race-1');
  const second = settle('race-2');
  child.stdin.write(
    ['race-1', 'race-2']
      .map((id) =>
        JSON.stringify({
          id,
          method: 'run.start',
          params: { sessionId: session.id, prompt: 'go' },
        }),
      )
      .join('\n') + '\n',
  );
  await Promise.all([first, second]);

  const started = [...outcomes.values()].filter((outcome) => outcome.ok);
  const rejected = [...outcomes.values()].filter((outcome) => !outcome.ok);
  assert.equal(started.length, 1, `exactly one run.start may be admitted: ${stderr}`);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.error!.message, /already has an active run/);
  assert.equal(started[0]!.value.status, 'completed');

  // The slot is released when the run settles, so a later run is admitted normally.
  const later = await rpc('run.start', { sessionId: session.id, prompt: 'again' });
  assert.equal(later.status, 'completed');

  child.stdin.end();
  const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(exit, 0, stderr);
});
