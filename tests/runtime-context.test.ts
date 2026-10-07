/**
 * Context the conversation carries instead of the prompt: the workspace outline and saved memory.
 *
 * §3-4 names these as the volatile half of the system prompt, and the reason they matter is the prompt cache: the
 * system prompt is the head of the provider's cacheable prefix, so a section that changes whenever a file does —
 * which for a workspace outline is every round that edits anything — invalidates the tool catalogue and the whole
 * conversation behind it. The tests below pin the three properties the replacement has to have to be worth
 * anything: the text still reaches the model, an unchanged state announces nothing (so the prefix is
 * byte-identical), and the reading survives a resume because it comes from the log rather than from memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import {
  RUNTIME_SNAPSHOT_SOURCES,
  lastRuntimeSnapshot,
  runtimeSnapshotMessage,
  runtimeSnapshotText,
} from '../packages/core/runtime-context.ts';
import { isMachineContext, isRuntimeContext } from '../packages/protocol/context.ts';
import { resetRepoMapCache } from '../packages/tools/repo-map.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { capacityResolver, modelInfoFor } from '../apps/shared/runtime.ts';
import { parseArgs } from '../apps/shared/args.ts';
import type { Message, ModelResponse, Provider, Questioner } from '../packages/protocol/index.ts';

const reply = (text = 'Done'): ModelResponse => ({
  text,
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
/**
 * A workspace with one file the outline can describe, and a store the tests own so a "second process" can be
 * simulated by reopening it.
 */
async function fixture(t: test.TestContext, provider: Provider, db?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-runtime-context-'));
  const file = db ?? path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  resetRepoMapCache();
  t.after(async () => {
    // A test that simulates a second process closes this store itself, so closing it again here has to be a
    // no-op rather than the last thing the test reports.
    try {
      store.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'app.ts'), 'export class Server {}\n');
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    question: (async () => ({ answered: false, answers: [] })) satisfies Questioner,
  });
  return { root, db: file, store, sessionId: session.id, agent };
}
/** What each request carried, as the model received it. The script decides what the model answers with. */
function recorder(script: (round: number) => ModelResponse = () => reply('Done')) {
  const requests: { system: string; messages: Message[] }[] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      requests.push({ system: request.system, messages: request.messages });
      round++;
      return script(round);
    },
  };
  return { requests, provider };
}
const snapshotsIn = (messages: readonly Message[], source: string) =>
  messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.content.startsWith(`<runtime-context source="${source}">`),
    )
    .map((message) => message.content);

test('a redacted model label keeps the configured request budget', async (t) => {
  const previousKey = process.env.YUANTU_API_KEY;
  process.env.YUANTU_API_KEY = 'budget-fixture';
  t.after(() => {
    if (previousKey === undefined) delete process.env.YUANTU_API_KEY;
    else process.env.YUANTU_API_KEY = previousKey;
  });
  const config = {
    apiKey: 'budget-fixture',
    model: 'progress-budget-fixture',
    protocol: 'openai' as const,
    baseUrl: 'https://budget.invalid/v1',
    maxContextTokens: 128_000,
    maxOutputTokens: 100,
  };
  const modelInfo = modelInfoFor(config);
  assert.equal(modelInfo.model, 'progress-[redacted]');
  const capacityFor = capacityResolver(parseArgs([], {}).options, config);
  assert.equal(capacityFor(modelInfo.model)?.contextWindow, 128_000);
  assert.equal(capacityFor(modelInfo.model)?.maxOutputTokens, 100);
  assert.notEqual(capacityFor('other-model')?.contextWindow, 128_000);
  let outputBudget: number | undefined;
  const provider: Provider = {
    async complete(request) {
      outputBudget = request.maxOutputTokens;
      return reply();
    },
  };
  const { store, sessionId, root } = await fixture(t, provider);
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => false,
    modelInfo,
    capacityFor,
    maxContextTokens: 128_000,
    maxOutputTokens: 100,
  });
  const result = await agent.run({ sessionId, prompt: 'Keep the configured budget' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(outputBudget, 100);
});

test('the newest announcement of a source is the one the conversation is read back from', () => {
  const empty: Message[] = [];
  assert.equal(lastRuntimeSnapshot(empty, 'workspace-outline'), undefined);
  const first = runtimeSnapshotMessage('workspace-outline', 'app.ts: class Server:1');
  const second = runtimeSnapshotMessage('workspace-outline', 'app.ts: class Server:1\nnew.ts: f:1');
  assert.equal(
    lastRuntimeSnapshot([{ role: 'user', content: first }], 'workspace-outline'),
    runtimeSnapshotText('workspace-outline', 'app.ts: class Server:1'),
  );
  const both: Message[] = [
    { role: 'user', content: first },
    { role: 'assistant', content: 'ok', toolCalls: [] },
    { role: 'user', content: second },
  ];
  assert.match(
    lastRuntimeSnapshot(both, 'workspace-outline')!,
    /new\.ts/,
    'the newest one is what the conversation currently says',
  );
  // Another source's snapshot is not this source's, even though both are wrapped the same way.
  assert.equal(
    lastRuntimeSnapshot(
      [{ role: 'user', content: runtimeSnapshotMessage('memory', 'x') }],
      'memory',
    ),
    runtimeSnapshotText('memory', 'x'),
  );
  assert.equal(
    lastRuntimeSnapshot(
      [{ role: 'user', content: runtimeSnapshotMessage('memory', 'x') }],
      'workspace-outline',
    ),
    undefined,
  );
  /**
   * And the markers have to be a *message's own* wrapper at both ends.
   *
   * A model that quotes a snapshot back, or a message that got truncated, would otherwise read as the current
   * state — and the announcement would stop, leaving the model with a copy of a copy.
   */
  assert.equal(
    lastRuntimeSnapshot(
      [{ role: 'user', content: `here is what I saw:\n${first}\nthat is all` }],
      'workspace-outline',
    ),
    undefined,
  );
  assert.equal(
    lastRuntimeSnapshot(
      [{ role: 'user', content: first.replace('\n</runtime-context>', '') }],
      'workspace-outline',
    ),
    undefined,
  );
  assert.deepEqual(
    [...RUNTIME_SNAPSHOT_SOURCES],
    ['task', 'memory', 'skills', 'workspace-outline'],
  );
});

test('a snapshot is recognisable from its own wrapper, and a lookalike is not', () => {
  /**
   * Three readers answer this question and they have to agree: the transcript (what to draw), the storage layer
   * (which message may name a session) and the title path (whether anybody has asked this session anything). The
   * tag lives in `packages/protocol/context.ts`, which is what makes one answer possible.
   */
  assert.equal(isRuntimeContext(runtimeSnapshotMessage('memory', 'x')), true);
  assert.equal(isRuntimeContext(runtimeSnapshotMessage('task', 'x')), true);
  assert.equal(
    isRuntimeContext('the model quoted it: <runtime-context source="memory">\nx'),
    false,
    'a quote is not the wrapper',
  );
  assert.equal(isRuntimeContext('<compacted-summary>\nx\n</compacted-summary>'), false);
  assert.equal(isRuntimeContext('what the user typed'), false);
  // The summary is machine-written too, so the two predicates differ on exactly that case.
  assert.equal(isMachineContext('<compacted-summary>\nx\n</compacted-summary>'), true);
  assert.equal(isMachineContext(runtimeSnapshotMessage('skills', 'x')), true);
  assert.equal(isMachineContext('what the user typed'), false);
});

test('the transcript leaves a snapshot out while the session keeps it', () => {
  /**
   * What the window draws is filtered, not what the session holds: the model still receives the snapshot and the
   * log still stores it, which is why the filter lives in the renderer rather than in the message list.
   */
  const messages: Message[] = [
    { role: 'user', content: 'look at the tree' },
    { role: 'user', content: runtimeSnapshotMessage('workspace-outline', 'app.ts: f:1') },
    { role: 'assistant', content: 'ok', toolCalls: [] },
  ];
  const drawn = messages.filter(
    (message) => !(message.role === 'user' && isRuntimeContext(message.content)),
  );
  assert.deepEqual(
    drawn.map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(messages.length, 3, 'and the session the list came from is untouched');
});

test('a workspace that changed between runs appends the outline instead of rewriting the prompt', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const requests: { system: string; messages: Message[] }[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push({ system: request.system, messages: request.messages });
      return reply('Done');
    },
  };
  const first = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await first.run({ sessionId, prompt: '看一下这个项目' });
  await writeFile(path.join(root, 'added.ts'), 'export function added() {}\n');
  const second = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
  });
  await second.run({ sessionId, prompt: '再改一处' });

  assert.equal(
    new Set(requests.map((request) => request.system)).size,
    1,
    'one prompt for two runs',
  );
  // The snapshot is announced before the run's own prompt, so the person's request stays the last thing said.
  assert.match(requests[0]!.messages[0]!.content, /^<runtime-context source="workspace-outline">/);
  assert.match(requests[0]!.messages[1]!.content, /看一下这个项目/);
  const seen = snapshotsIn(requests[1]!.messages, 'workspace-outline');
  assert.equal(seen.length, 2, 'the conversation holds both snapshots, oldest first');
  assert.match(seen[1]!, /added\.ts/);
  assert.ok(!seen[0]!.includes('added.ts'), 'the older one is what the tree was');
  assert.doesNotMatch(requests[0]!.messages.map((m) => m.content).join('\n'), /added\.ts/);
});

test('an unchanged workspace announces nothing, and the second request is the same prefix', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const { requests, provider } = recorder();
  for (const prompt of ['第一轮', '第二轮']) {
    const agent = new Agent({
      store,
      provider,
      tools: createTools(root),
      approve: async () => true,
    });
    await agent.run({ sessionId, prompt });
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(
    snapshotsIn(requests[1]!.messages, 'workspace-outline'),
    snapshotsIn(requests[0]!.messages, 'workspace-outline'),
    'nothing was said twice',
  );
  assert.equal(snapshotsIn(requests[1]!.messages, 'workspace-outline').length, 1);
  // And the model still has it: the snapshot is in the conversation the second request carries, not re-sent.
  assert.match(requests[1]!.messages.map((m) => m.content).join('\n'), /class Server/);
});

test('a resumed session reads the snapshot out of the log rather than announcing it again', async (t) => {
  const { root, db, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const requests: { system: string; messages: Message[] }[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push({ system: request.system, messages: request.messages });
      return reply('Done');
    },
  };
  const first = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await first.run({ sessionId, prompt: '第一轮' });
  // A second process: nothing of the first one is in memory, so anything it knows it read back.
  store.close();
  const reopened = new SessionStore(db);
  try {
    resetRepoMapCache();
    const second = new Agent({
      store: reopened,
      provider,
      tools: createTools(root),
      approve: async () => true,
    });
    await second.run({ sessionId, prompt: '第二轮' });

    assert.equal(
      new Set(requests.map((request) => request.system)).size,
      1,
      'one prompt for two runs',
    );
    assert.equal(
      snapshotsIn(requests[1]!.messages, 'workspace-outline').length,
      1,
      'the reopened process found the outline in the conversation it was sent',
    );
  } finally {
    reopened.close();
  }
});

test('memory written during a run reaches the next round as a snapshot', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const { requests, provider } = recorder((round) =>
    round === 1
      ? toolCall('save-1', 'save_memory', {
          scope: 'workspace',
          key: 'theme',
          content: 'Keep the palette blue.',
        })
      : reply('记住了。'),
  );
  const agent = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await agent.run({ sessionId, prompt: '记住配色' });

  assert.equal(requests.length, 2, 'the tool call and the answer are two rounds');
  assert.equal(
    snapshotsIn(requests[0]!.messages, 'memory').length,
    0,
    'there was nothing saved before the write',
  );
  const after = snapshotsIn(requests[1]!.messages, 'memory');
  assert.equal(after.length, 1);
  assert.match(after[0]!, /Keep the palette blue\./);
  assert.ok(!requests[1]!.system.includes('Keep the palette blue.'), 'and not through the prompt');
});

test('a snapshot the model can no longer see is announced again after a compaction', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const { requests, provider } = recorder();
  const first = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await first.run({ sessionId, prompt: '第一轮' });
  // The transcript keeps growing, and a compaction covers the outline along with the rest of the head.
  for (let index = 0; index < 4; index++)
    store.append(sessionId, { role: 'assistant', content: `work ${index}`, toolCalls: [] });
  const messages = store.messages(sessionId);
  const snapshotAt = messages.findIndex(
    (message) =>
      message.role === 'user' &&
      message.content.startsWith('<runtime-context source="workspace-outline">'),
  );
  assert.ok(snapshotAt >= 0);
  store.applyCompaction(sessionId, {
    coveredMessages: snapshotAt + 1,
    summary: 'Earlier work, in summary.',
  });
  const second = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
  });
  await second.run({ sessionId, prompt: '继续' });

  const carried = snapshotsIn(requests[1]!.messages, 'workspace-outline');
  assert.equal(carried.length, 1, 'the outline is back in the window the model is sent');
  assert.match(carried[0]!, /class Server/);
  assert.equal(new Set(requests.map((request) => request.system)).size, 1, 'still one prompt');
});

test('an approved task is announced, and a step that completes updates it in place', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const task = store.createTask(sessionId, {
    title: 'Ship the loader',
    steps: [
      { description: 'inspect', status: 'pending' },
      { description: 'implement', status: 'pending' },
    ],
    acceptance: [{ description: 'the loader loads', met: false }],
  });
  const { requests, provider } = recorder((round) =>
    round === 1
      ? toolCall('step-1', 'task_step', { index: 0, status: 'completed' })
      : reply('第一步完成。'),
  );
  const agent = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await agent.run({ sessionId, taskId: task.id, prompt: '开始' });

  assert.equal(requests.length, 2, 'the checkpoint and the answer are two rounds');
  assert.equal(
    new Set(requests.map((request) => request.system)).size,
    1,
    'a step that completed did not rewrite the prompt',
  );
  const first = snapshotsIn(requests[0]!.messages, 'task');
  assert.equal(first.length, 1);
  assert.match(first[0]!, /Approved task definition \(user-controlled/);
  assert.match(first[0]!, /the loader loads/, 'the acceptance criteria travel with it');
  assert.match(first[0]!, /"status":"pending"/);
  const after = snapshotsIn(requests[1]!.messages, 'task');
  assert.equal(after.length, 2, 'the round after the checkpoint holds both readings');
  assert.match(after[1]!, /"status":"completed"/);
  assert.ok(!requests[1]!.system.includes('Approved task definition'), 'never the prompt');
  // No instruction about where to continue, because this run started with nothing done.
  assert.ok(!after[0]!.includes('are already completed'));
});

test('a task resumed with work already on disk is told what not to repeat', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const task = store.createTask(sessionId, {
    title: 'Finish the loader',
    steps: [
      { description: 'inspect', status: 'pending' },
      { description: 'implement', status: 'pending' },
    ],
  });
  // A new task starts with every step pending, so the work on disk is what a finished attempt leaves behind.
  const attempt = store.startTaskAttempt(sessionId, task.id, { kind: 'run' });
  store.checkpointTaskStep(sessionId, task.id, {
    attemptId: attempt.id,
    index: 0,
    status: 'completed',
    note: 'already inspected',
  });
  store.finishTaskAttempt(sessionId, task.id, attempt.id, { status: 'needs_review' });
  const { requests, provider } = recorder();
  const agent = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  // `resumeTask` is what the host sends when it picks an interrupted attempt back up, and it is also what
  // carries the earlier attempt's checkpoints into this one: without it a new attempt starts the steps over.
  await agent.run({ sessionId, taskId: task.id, prompt: '继续', resumeTask: true });

  const carried = snapshotsIn(requests[0]!.messages, 'task');
  assert.equal(carried.length, 1);
  assert.match(carried[0]!, /Steps 0 are already completed/);
  assert.match(carried[0]!, /continue from step 1/);
  assert.ok(!requests[0]!.system.includes('already completed and their effects are on disk'));
  /**
   * And the sentence follows the step list rather than the other way round: a run that starts with nothing done
   * says nothing about where to continue, and says it one round later once it has checkpointed a step itself.
   */
  const fresh = store.createTask(sessionId, {
    title: 'From scratch',
    steps: [{ description: 'only', status: 'pending' }],
  });
  const freshRun = recorder((round) =>
    round === 1
      ? toolCall('step-2', 'task_step', { index: 0, status: 'completed' })
      : reply('done'),
  );
  const second = new Agent({
    store,
    provider: freshRun.provider,
    tools: createTools(root),
    approve: async () => true,
  });
  await second.run({ sessionId, taskId: fresh.id, prompt: '开始' });
  /**
   * The *newest* task snapshot is this run's, not the earlier task's.
   *
   * These are two tasks in one session, and the source is per section rather than per task: last-wins means the
   * newest statement is the current one, so a session that switches tasks announces the task it is running now
   * (one message, never a prompt change) rather than leaving the previous task's list reading as current.
   */
  const told = snapshotsIn(freshRun.requests[0]!.messages, 'task');
  assert.match(told.at(-1)!, /"title":"From scratch"/);
  assert.ok(
    !told.at(-1)!.includes('are already completed'),
    'nothing was done when this run started',
  );
  const next = snapshotsIn(freshRun.requests[1]!.messages, 'task');
  assert.match(next.at(-1)!, /"status":"completed"/);
  assert.match(next.at(-1)!, /Steps 0 are already completed/);
  assert.ok(next.length > told.length, 'the checkpoint added a reading rather than rewriting one');
});

test('a skill written during a run is announced instead of changing the prompt', async (t) => {
  const { root, store, sessionId } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  const { requests, provider } = recorder((round) =>
    round === 1
      ? toolCall('write-1', 'write_file', {
          // `.agents` rather than `.yuantu`: the latter is the runtime's own state directory, and a test about
          // skills has no reason to write into it. The directory below exists because `write_file` writes one
          // file rather than creating a tree — a skill appearing in a workspace that already has the folder is
          // the case that matters, and the assertion after the run reports the tool's own answer if it refused.
          path: '.agents/skills/release/SKILL.md',
          content: '---\nname: release\ndescription: How releases are cut\n---\nsteps\n',
        })
      : reply('记住了。'),
  );
  await mkdir(path.join(root, '.agents/skills/release'), { recursive: true });
  const agent = new Agent({ store, provider, tools: createTools(root), approve: async () => true });
  await agent.run({ sessionId, prompt: '写一个发布技能' });

  assert.equal(requests.length, 2, 'the write and the answer are two rounds');
  // The skill has to be there for the announcement to have anything to say: assert the write itself worked.
  const written = store
    .messages(sessionId)
    .find((message) => message.role === 'tool' && message.toolCallId === 'write-1');
  assert.ok(
    written?.role === 'tool' && written.isError === false,
    `the skill file was written: ${written?.role === 'tool' ? written.content : 'no tool result'}`,
  );
  assert.equal(new Set(requests.map((request) => request.system)).size, 1, 'one prompt throughout');
  assert.equal(
    snapshotsIn(requests[0]!.messages, 'skills').length,
    0,
    'the workspace offered no skills when the run started',
  );
  const after = snapshotsIn(requests[1]!.messages, 'skills');
  assert.equal(after.length, 1);
  assert.match(after[0]!, /Available skills \(use load_skill to read relevant guidance\):/);
  assert.match(after[0]!, /release: How releases are cut/);
  assert.ok(!requests[1]!.system.includes('How releases are cut'), 'and not through the prompt');
});
