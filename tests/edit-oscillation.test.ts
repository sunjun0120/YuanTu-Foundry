import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { ToolProgressGuard, type ToolObservation } from '../packages/core/tool-progress.ts';
import { createTools } from '../packages/catalog/index.ts';
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
import { digestFileStates } from '../packages/tools/file-state-digest.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import type {
  AgentEvent,
  FileChange,
  ModelResponse,
  Provider,
  ToolCall,
} from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolReply = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  ...reply(),
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
});
async function fixture(t: test.TestContext, provider: Provider, extra = {}) {
  const { root, store, session } = await storeFixture(t, 'yuantu-oscillation-');
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { root, store, session, agent, events, tools };
}

// ---- the write-boundary digest -------------------------------------------------------------

test('a write is reduced to content hashes and one hash per changed block', () => {
  const [digest] = digestFileStates([
    { path: 'a.txt', before: Buffer.from('one\ntwo\n'), after: Buffer.from('one\nTWO\n') },
  ])!;
  assert.equal(digest!.path, 'a.txt');
  assert.match(digest!.before!, /^[0-9a-f]{64}$/);
  assert.match(digest!.after!, /^[0-9a-f]{64}$/);
  assert.notEqual(digest!.before, digest!.after);
  assert.equal(digest!.hunks.length, 1);
  // A whole-file replacement is still one block, and its two sides are the two line sets.
  const [created] = digestFileStates([
    { path: 'new.txt', before: null, after: Buffer.from('fresh\n') },
  ])!;
  assert.equal(created!.before, null);
  assert.equal(created!.hunks.length, 1);
  const [deleted] = digestFileStates([
    { path: 'new.txt', before: Buffer.from('fresh\n'), after: null },
  ])!;
  assert.equal(deleted!.after, null);
  // The reverse of a creation is the creation's own block read the other way round.
  assert.equal(deleted!.hunks[0]!.deleted, created!.hunks[0]!.added);
  assert.equal(deleted!.hunks[0]!.added, created!.hunks[0]!.deleted);
});

test('line endings are the one normalization, and content that cannot be diffed has no blocks', () => {
  const crlf = digestFileStates([
    { path: 'a.txt', before: Buffer.from('one\r\ntwo\r\n'), after: Buffer.from('one\r\nTWO\r\n') },
  ])!;
  const lf = digestFileStates([
    { path: 'a.txt', before: Buffer.from('one\ntwo\n'), after: Buffer.from('one\nTWO\n') },
  ])!;
  assert.deepEqual(crlf[0]!.hunks, lf[0]!.hunks);
  // Whole-file hashes keep the bytes: the two files are different files even if their lines are the same.
  assert.notEqual(crlf[0]!.before, lf[0]!.before);
  // A binary or oversized file still has whole-file hashes, and no block to compare.
  const binary = digestFileStates([
    { path: 'b.bin', before: null, after: Buffer.from([0, 1, 2]) },
  ])!;
  assert.equal(binary[0]!.hunks.length, 0);
  const oversized = digestFileStates([
    { path: 'big.txt', before: null, after: Buffer.alloc(1_000_001, 0x61) },
  ])!;
  assert.equal(oversized[0]!.hunks.length, 0);
});

// ---- the guard ------------------------------------------------------------------------------

let writes = 0;
const change = (file: string): FileChange => ({
  path: file,
  kind: 'edit',
  patch: '',
  added: 1,
  removed: 1,
  truncated: false,
});
/** One successful write of one file, digested exactly as the write boundary would digest it. */
function written(
  file: string,
  before: string | null,
  after: string | null,
  options: { isError?: boolean; bytes?: { before: Buffer | null; after: Buffer | null } } = {},
): ToolObservation {
  const call: ToolCall = {
    id: `write-${++writes}`,
    name: 'edit_file',
    arguments: { path: file },
  };
  return {
    call,
    result: { isError: options.isError ?? false, content: 'Applied', change: change(file) },
    fileStates: digestFileStates([
      {
        path: file,
        before: options.bytes ? options.bytes.before : before === null ? null : Buffer.from(before),
        after: options.bytes ? options.bytes.after : after === null ? null : Buffer.from(after),
      },
    ]),
  };
}
const counts = (guard: ToolProgressGuard) =>
  guard.takeOscillationEvents().map((event) => event.count);

test('the same file going back to an earlier state is counted per write, and told twice', () => {
  const guard = new ToolProgressGuard();
  const states: [string, string][] = [
    ['X', 'Y'],
    ['Y', 'X'],
    ['X', 'Y'],
    ['Y', 'X'],
    ['X', 'Y'],
  ];
  assert.equal(guard.observeRound([written('a.txt', ...states[0]!)]), 'continue');
  assert.deepEqual(counts(guard), []);
  assert.equal(guard.observeRound([written('a.txt', ...states[1]!)]), 'continue');
  assert.deepEqual(counts(guard), [1]);
  assert.equal(guard.observeRound([written('a.txt', ...states[2]!)]), 'edit-oscillation-warn');
  assert.deepEqual(counts(guard), [2]);
  assert.equal(guard.observeRound([written('a.txt', ...states[3]!)]), 'continue');
  assert.deepEqual(counts(guard), [3]);
  assert.equal(
    guard.observeRound([written('a.txt', ...states[4]!)]),
    'edit-oscillation-warn-final',
  );
  assert.deepEqual(counts(guard), [4]);
  // Neither level is said twice.
  assert.equal(guard.observeRound([written('a.txt', ...states[3]!)]), 'continue');
  assert.deepEqual(counts(guard), [5]);
});

test('a block that returns to an earlier form counts even when the file never repeats', () => {
  const guard = new ToolProgressGuard();
  // Three lines edited in turn: every whole-file state is new, and three writes reverse a block.
  const states = [
    'X1\nY1\nZ1',
    'X2\nY1\nZ1',
    'X2\nY2\nZ1',
    'X1\nY2\nZ1',
    'X1\nY2\nZ2',
    'X2\nY2\nZ2',
    'X2\nY1\nZ2',
  ];
  const results = states
    .slice(1)
    .map((state, index) => guard.observeRound([written('a.txt', states[index]!, state)]));
  assert.deepEqual(results, [
    'continue',
    'continue',
    'continue',
    'continue',
    'edit-oscillation-warn',
    'continue',
  ]);
  assert.deepEqual(counts(guard), [1, 2, 3]);
});

test('one write counts once however many of its blocks reversed or signals hit', () => {
  const guard = new ToolProgressGuard();
  guard.observeRound([written('a.txt', 'X1 Y1', 'X2 Y2')]);
  guard.observeRound([written('a.txt', 'X2 Y2', 'X1 Y1')]);
  assert.deepEqual(counts(guard), [1]);
  // Both signals at once: the file returns to a state it had, and a block reverses.
  guard.observeRound([written('a.txt', 'X1 Y1', 'X1 Y2')]);
  guard.observeRound([written('a.txt', 'X1 Y2', 'X1 Y1')]);
  assert.deepEqual(counts(guard), [2]);
});

test('creating, deleting and re-creating a path counts the two returns, and so does a move back', () => {
  const guard = new ToolProgressGuard();
  guard.observeRound([written('new.txt', null, 'content')]);
  assert.deepEqual(counts(guard), []);
  guard.observeRound([written('new.txt', 'content', null)]);
  assert.deepEqual(counts(guard), [1]);
  guard.observeRound([written('new.txt', null, 'content')]);
  assert.deepEqual(counts(guard), [2]);
  const moves = new ToolProgressGuard();
  // A move writes two paths in one call: the source disappears and the destination appears.
  const move = (from: string, to: string, content: string): ToolObservation => ({
    call: { id: `move-${++writes}`, name: 'move_file', arguments: { from, to } },
    result: {
      isError: false,
      content: 'Moved',
      change: { ...change(to), kind: 'move', changes: [change(from), change(to)] },
    },
    fileStates: digestFileStates([
      { path: from, before: Buffer.from(content), after: null },
      { path: to, before: null, after: Buffer.from(content) },
    ]),
  });
  assert.equal(moves.observeRound([move('a.txt', 'b.txt', 'body')]), 'continue');
  assert.deepEqual(counts(moves), []);
  assert.equal(moves.observeRound([move('b.txt', 'a.txt', 'body')]), 'continue');
  assert.deepEqual(counts(moves), [1]);
});

test('failed and no-op writes are neither counted nor remembered', () => {
  const guard = new ToolProgressGuard();
  guard.observeRound([written('a.txt', 'X', 'Y')]);
  // A write that failed never happened: its destination state must not become a state of the file.
  guard.observeRound([written('a.txt', 'Y', 'Z', { isError: true })]);
  guard.observeRound([written('a.txt', 'Y', 'Z')]);
  assert.deepEqual(counts(guard), []);
  guard.observeRound([written('a.txt', 'Z', 'Y')]);
  assert.deepEqual(counts(guard), [1]);
  // A reported write whose bytes are identical is not evidence the model went anywhere, and does not seed a state.
  guard.observeRound([written('b.txt', 'Q', 'Q')]);
  guard.observeRound([written('b.txt', 'R', 'Q')]);
  assert.deepEqual(counts(guard), []);
});

test('editing forward on one path, or across paths, is not an oscillation', () => {
  const guard = new ToolProgressGuard();
  for (const [before, after] of [
    ['X1', 'X2'],
    ['X2', 'X3'],
    ['X3', 'X4'],
  ])
    assert.equal(guard.observeRound([written('a.txt', before!, after!)]), 'continue');
  assert.deepEqual(counts(guard), []);
  const across = new ToolProgressGuard();
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    across.observeRound([written(file, 'same', 'other')]);
  assert.deepEqual(counts(across), []);
});

test('a conclusion round takes precedence, and the notice is kept for the next one', () => {
  const guard = new ToolProgressGuard();
  const missing = (): ToolObservation => ({
    call: { id: 'read-missing', name: 'read_file', arguments: { path: 'missing.txt' } },
    result: { isError: true, content: 'ENOENT missing.txt' },
  });
  assert.equal(guard.observeRound([missing(), missing(), written('a.txt', 'X', 'Y')]), 'continue');
  assert.equal(guard.observeRound([missing(), missing(), written('a.txt', 'Y', 'X')]), 'continue');
  assert.deepEqual(counts(guard), [1]);
  // The fifth identical failure is the conclusion: the oscillation notice this round earned is not injected.
  assert.equal(guard.observeRound([missing(), written('a.txt', 'X', 'Y')]), 'conclude');
  assert.deepEqual(counts(guard), [2]);
  // A later round that does not conclude gets the notice the conclusion pre-empted.
  assert.equal(guard.observeRound([written('a.txt', 'Y', 'X')]), 'edit-oscillation-warn');
});

test('only a person or a policy clears the count; new evidence does not', () => {
  const guard = new ToolProgressGuard();
  guard.observeRound([written('a.txt', 'X', 'Y')]);
  guard.observeRound([written('a.txt', 'Y', 'X')]);
  assert.deepEqual(counts(guard), [1]);
  // `reset()` is the "new evidence arrived" clear, and the oscillation count has to survive exactly that.
  guard.reset();
  guard.observeRound([written('a.txt', 'X', 'Y')]);
  assert.deepEqual(counts(guard), [2]);
  guard.resetOscillation();
  // The cleared guard has no history for the path, so the first write after the clear cannot be a return to it.
  guard.observeRound([written('a.txt', 'X', 'Y')]);
  assert.deepEqual(counts(guard), []);
  guard.observeRound([written('a.txt', 'Y', 'X')]);
  assert.deepEqual(counts(guard), [1]);
});

// ---- the run --------------------------------------------------------------------------------

const edit = (id: string, oldText: string, newText: string): ModelResponse =>
  toolReply(id, 'edit_file', { path: 'target.txt', old_text: oldText, new_text: newText });

test('a run that reverts its own edits is told twice, keeps its tools and stops on its own', async (t) => {
  // The file alternates a→b→a→b→a→b: five writes, four of them undoing the previous one.
  const targets = ['b', 'a', 'b', 'a', 'b'];
  const offered: string[][] = [];
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      offered.push(request.tools.map((tool) => tool.name));
      if (round === 1) return toolReply('read', 'read_file', { path: 'target.txt' });
      if (round <= 6) {
        const current = (await readFile(path.join(ctx.root, 'target.txt'), 'utf8')).trim();
        return edit(`edit-${round}`, current, targets[round - 2]!);
      }
      return reply('Settled on the first version');
    },
  });
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 7, 'no extra round is spent stopping the model');
  const notices = ctx.events.filter(
    (event) => event.type === 'context.injected' && event.data.source === 'tool-progress',
  );
  assert.deepEqual(
    notices.map((event) => event.data.action),
    ['edit-oscillation-warn', 'edit-oscillation-warn-final'],
  );
  const messages = ctx.store.messages(ctx.session.id).filter((m) => m.role === 'user');
  const texts = messages
    .filter((message) => isRuntimeContext(message.content))
    .map((message) => message.content);
  assert.ok(texts.some((text) => text.includes('You are undoing edits')));
  assert.ok(texts.some((text) => text.includes('Going back and forth')));
  // Every edit request kept the whole catalogue: the prompt never became a restriction.
  for (const names of offered.slice(1)) {
    assert.ok(names.includes('edit_file'), names.join(','));
    assert.ok(names.includes('search_files'), names.join(','));
  }
  // One record per hit, with the count and the signal, readable after a reload. Rounds are zero-based.
  const recorded = ctx.store.events(ctx.session.id).filter((e) => e.type === 'edit.oscillation');
  assert.deepEqual(
    recorded.map((event) => event.data),
    [
      { runId: result.runId, round: 2, count: 1, signal: 'full' },
      { runId: result.runId, round: 3, count: 2, signal: 'full' },
      { runId: result.runId, round: 4, count: 3, signal: 'full' },
      { runId: result.runId, round: 5, count: 4, signal: 'full' },
    ],
  );
  assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'b');
});

test('a targeted read still counts the edit it enables, and does not lift the act-phase exit rules', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete() {
      const round = ++requests;
      if (round <= 4) {
        now += 30_000;
        return toolReply(`read-${round}`, 'read_file', {
          path: round === 1 ? 'target.txt' : `in-${round}.txt`,
        });
      }
      const current = (await readFile(path.join(ctx.root, 'target.txt'), 'utf8')).trim();
      if (round === 5) return edit('act-1', current, 'b');
      if (round === 6) return edit('act-2', current, 'a');
      if (round === 7) return edit('act-3', current, 'b');
      return reply('Stopped switching');
    },
  });
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.notEqual(result.status, 'failed', result.error);
  const notices = ctx.events.filter(
    (event) => event.type === 'context.injected' && event.data.source === 'tool-progress',
  );
  assert.ok(
    notices.some((event) => event.data.action === 'edit-oscillation-warn'),
    JSON.stringify(notices.map((event) => event.data.action)),
  );
});

test('a follow-up from the person starts the count over', async (t) => {
  let requests = 0;
  const ctx = await fixture(t, {
    async complete() {
      const round = ++requests;
      if (round === 1) return toolReply('read', 'read_file', { path: 'target.txt' });
      if (round === 4) {
        // The person speaks once the first reversal has been counted; the runtime consumes the message before
        // the next round is requested.
        ctx.agent.enqueue(ctx.session.id, { prompt: 'Try the other way' }, 'follow-up');
        return reply('Paused for the follow-up');
      }
      const current = (await readFile(path.join(ctx.root, 'target.txt'), 'utf8')).trim();
      if (round === 2) return edit('edit-2', current, 'b');
      if (round === 3) return edit('edit-3', current, 'a');
      if (round === 5) return edit('edit-5', current, 'b');
      if (round === 6) return edit('edit-6', current, 'a');
      return reply('Done');
    },
  });
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  // Writes: a→b (0), b→a (1), then the follow-up clears it, so a→b→a counts from one again.
  const recorded = ctx.store.events(ctx.session.id).filter((e) => e.type === 'edit.oscillation');
  assert.deepEqual(
    recorded.map((event) => event.data.count),
    [1, 1],
  );
});

test('a policy change starts the count over', async (t) => {
  const targets = ['b', 'a', 'b', 'a'];
  let policy = new PermissionPolicy({ version: 1, rules: [] });
  let requests = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        const round = ++requests;
        if (round === 1) return toolReply('read', 'read_file', { path: 'target.txt' });
        if (round <= 5) {
          const current = (await readFile(path.join(ctx.root, 'target.txt'), 'utf8')).trim();
          // A different policy object between rounds is what `refreshPolicies` notices.
          if (round === 3) policy = new PermissionPolicy({ version: 1, rules: [] });
          return edit(`edit-${round}`, current, targets[round - 2]!);
        }
        return reply('Done');
      },
    },
    {
      permissionPolicy: () => policy,
      approve: async () => true,
    },
  );
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.notEqual(result.status, 'failed', result.error);
  const recorded = ctx.store.events(ctx.session.id).filter((e) => e.type === 'edit.oscillation');
  assert.deepEqual(
    recorded.map((event) => event.data.count),
    [1, 1],
  );
});

test('an approved plan clears the count', async (t) => {
  // A planning run is read-only until the approval lands, so no edit can accumulate a count before it. What the
  // approval site owes the guard is the clear itself, and that is what this pins.
  const cleared = t.mock.method(ToolProgressGuard.prototype, 'resetOscillation');
  let requests = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        const round = ++requests;
        if (round === 1) return toolReply('read', 'read_file', { path: 'target.txt' });
        if (round === 2)
          return toolReply('approve-plan', 'exit_plan_mode', {
            title: 'Fix target',
            summary: 'Keep one version',
            steps: ['Edit target.txt'],
          });
        if (round === 3) return edit('edit-3', 'a', 'b');
        return reply('Done');
      },
    },
    {
      question: async () => ({
        answered: true,
        answers: [{ id: 'plan', selected: ['Approve and execute'] }],
      }),
    },
  );
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const plan = ctx.store.createPlan(ctx.session.id);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'Plan a fix',
    planPhase: true,
    planId: plan.id,
  });
  assert.notEqual(result.status, 'failed', result.error);
  assert.equal(
    cleared.mock.callCount(),
    1,
    'only the approval clears it in a read-only planning run',
  );
  assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'b');
});

test('a first write with inverse hunks does not undo an earlier write', () => {
  const guard = new ToolProgressGuard();
  const gap = Array.from({ length: 12 }, (_, index) => `keep-${index}`).join('\n');
  const before = `A\n${gap}\nB\n`;
  const after = `B\n${gap}\nA\n`;
  const observation = written('target.txt', before, after);
  assert.equal(observation.fileStates?.[0]?.hunks.length, 2);
  assert.equal(guard.observeRound([observation]), 'continue');
  assert.deepEqual(counts(guard), []);
});

test('prepared but abandoned journal snapshots are not successful writes', async (t) => {
  let requests = 0;
  const ctx = await fixture(t, {
    async complete() {
      return ++requests === 1 ? toolReply('retry', 'fixture_write', {}) : reply();
    },
  });
  ctx.tools.register({
    name: 'fixture_write',
    description: 'Fixture re-prepares a write',
    inputSchema: { type: 'object' },
    async execute(_args, context) {
      const fileChange = change('target.txt');
      context.fileJournal!.prepare(fileChange, Buffer.from('a'), Buffer.from('b'));
      const id = context.fileJournal!.prepare(fileChange, Buffer.from('b'), Buffer.from('a'));
      await writeFile(path.join(ctx.root, 'target.txt'), 'a');
      context.fileJournal!.applied(id);
      return { isError: false, content: 'Written', change: fileChange };
    },
  });
  await writeFile(path.join(ctx.root, 'target.txt'), 'b');
  await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Run the fixture write' });
  assert.deepEqual(
    ctx.store.events(ctx.session.id).filter((event) => event.type === 'edit.oscillation'),
    [],
  );
});

test('post-execute context does not skip oscillation observations', async (t) => {
  const targets = ['b', 'a', 'b', 'a', 'b'];
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
      if (round === 1) return toolReply('read', 'read_file', { path: 'target.txt' });
      if (round <= 6) {
        const current = await readFile(path.join(ctx.root, 'target.txt'), 'utf8');
        return edit(`edit-${round}`, current, targets[round - 2]!);
      }
      return reply('Done');
    },
  });
  ctx.tools.registerHooks({
    postExecute: () => ({
      action: 'add-context',
      context: 'Fixture context: continue from the current file bytes.',
    }),
  });
  await writeFile(path.join(ctx.root, 'target.txt'), 'a');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  const recorded = ctx.store
    .events(ctx.session.id)
    .filter((event) => event.type === 'edit.oscillation');
  assert.deepEqual(
    recorded.map((event) => event.data.count),
    [1, 2, 3, 4],
  );
  const notices = ctx.events.filter(
    (event) =>
      event.type === 'context.injected' && String(event.data.action).startsWith('edit-oscillation'),
  );
  assert.deepEqual(
    notices.map((event) => event.data.action),
    ['edit-oscillation-warn', 'edit-oscillation-warn-final'],
  );
});
