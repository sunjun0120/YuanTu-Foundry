/**
 * The request envelope: what each round actually asked the model to read.
 *
 * The durable log's headline claim is "model-visible ⇒ recorded", and only the transcript half of it used to be
 * true: every message the model was given was an event, while the system prompt and the tool catalogue were
 * request fields and nothing else. So the motivating case is a workspace whose `AGENTS.md` changes between runs —
 * after that, nothing in the session could say what an earlier round had been made of.
 *
 * These tests pin the two halves that make the record usable rather than merely present: the *identity* (a digest
 * per part, so "was this the same prompt?" is answerable) and the *content* (the prompt itself, carried once per
 * distinct prompt per run and reassembled by the reader). The third is the honesty rule: a prompt too large to
 * copy is recorded as a prefix **and said to be one**, because a truncated copy passed off as the whole prompt is
 * the failure this record exists to rule out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, type AgentOptions } from '../packages/core/agent.ts';
import { envelopeEvent } from '../packages/core/envelope.ts';
import { ENVELOPE_SYSTEM_CHARS, foldContextEnvelopes } from '../packages/protocol/context.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type { ModelResponse, Provider, Questioner } from '../packages/protocol/index.ts';

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
async function fixture(
  t: test.TestContext,
  provider: Provider,
  files: Record<string, string> = {},
  options: Partial<AgentOptions> = {},
): Promise<{ root: string; store: SessionStore; sessionId: string; agent: Agent }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-envelope-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content);
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    ...options,
  });
  return { root, store, sessionId: session.id, agent };
}
const envelopesOf = (store: SessionStore, sessionId: string) =>
  foldContextEnvelopes(store.events(sessionId));
const recordsOf = (store: SessionStore, sessionId: string) =>
  store.events(sessionId).filter((event) => event.type === 'context.envelope');

test('a round records the prompt and the catalogue it was actually sent with', async (t) => {
  const provider: Provider = {
    async complete() {
      return reply('一句话回答。');
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider, {
    'AGENTS.md': '# 项目规则\n\n- 回答先给结论。\n',
  });
  await agent.run({ sessionId, prompt: '这个项目是做什么的？' });

  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes.length, 1, 'one round, one envelope');
  const [envelope] = envelopes;
  assert.equal(envelope!.round, 0);
  assert.ok(envelope!.runId, 'the run is named, because round numbers repeat in every run');
  assert.match(envelope!.model ?? '', /fixture|^$|./);
  // The *sent* prompt, not the base one: the workspace's own instructions are in it.
  assert.match(envelope!.system!, /回答先给结论/);
  assert.match(envelope!.system!, /You are YuanTu/);
  assert.equal(
    envelope!.systemBytes,
    Buffer.byteLength(envelope!.system!, 'utf8'),
    'the recorded size is the prompt that was sent',
  );
  assert.equal(envelope!.systemTruncated, undefined, 'a prompt this size is copied whole');
  assert.match(envelope!.systemHash, /^[0-9a-f]{64}$/);
  assert.match(envelope!.toolsHash, /^[0-9a-f]{64}$/);
  assert.ok(envelope!.toolsCount > 0);
  assert.ok(envelope!.toolsBytes > 0);
  assert.ok(
    envelope!.cacheKey,
    'the cache key the request carried is part of what the request was',
  );
  assert.equal(envelope!.maxOutputTokens > 0, true);

  // Which files the run loaded is durable too, so the prompt's `AGENTS.md` block can be traced to the file.
  const loaded = store.events(sessionId).find((event) => event.type === 'resources.loaded');
  assert.ok(loaded, 'resources.loaded is in the log, not only on the live channel');
  assert.deepEqual(loaded.data.instructions, ['AGENTS.md']);
  assert.deepEqual(loaded.data.skills, []);

  // And none of it became transcript: the model-visible history is what it always was.
  assert.deepEqual(
    store.messages(sessionId).map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('an unchanged prompt is copied once per run, and a later round still resolves to it', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      return round === 1 ? toolCall('ls-1', 'list_files', { path: '.' }) : reply('看完了。');
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider, {
    'AGENTS.md': '# 项目规则\n\n- 先读再改。\n',
  });
  await agent.run({ sessionId, prompt: '列出文件' });

  const records = recordsOf(store, sessionId);
  assert.equal(records.length, 2, 'a record per round');
  assert.equal(typeof records[0]!.data.system, 'string', 'the first round carries the prompt');
  assert.equal(
    records[1]!.data.system,
    undefined,
    'the second round records the identity and no second copy',
  );
  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes[1]!.systemHash, envelopes[0]!.systemHash);
  assert.equal(
    envelopes[1]!.system,
    envelopes[0]!.system,
    'the reader puts the omitted copy back from the record that carried it',
  );
  assert.equal(envelopes[1]!.round, 1);
  assert.equal(envelopes[1]!.systemBytes, envelopes[0]!.systemBytes);
});

test('a reopened session does not re-copy a prompt and catalogue the log already holds', async (t) => {
  /**
   * The rule that bounds the record's cost, and the reason the writer seeds itself from the session's newest
   * envelope rather than from an empty hand. The catalogue is the large half — tens of kilobytes of schemas — so
   * "one copy per run" would mean a session that runs a thousand times carrying a thousand copies of it.
   */
  const provider: Provider = {
    async complete() {
      return reply('好。');
    },
  };
  const { root, store, sessionId, agent } = await fixture(t, provider, {
    'AGENTS.md': '# 规则\n\n- 一行。\n',
  });
  await agent.run({ sessionId, prompt: '第一轮' });
  const second = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
  });
  await second.run({ sessionId, prompt: '第二轮' });

  const records = recordsOf(store, sessionId);
  assert.equal(records.length, 2, 'a record per round, across both runs');
  assert.equal(records[1]!.data.system, undefined, 'the prompt was already in the log');
  assert.equal(records[1]!.data.tools, undefined, 'and so was the catalogue');
  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes[1]!.system, envelopes[0]!.system);
  assert.deepEqual(envelopes[1]!.tools, envelopes[0]!.tools);
  assert.notEqual(
    envelopes[1]!.runId,
    envelopes[0]!.runId,
    'two runs still, with their own identities',
  );
});

test('a prompt that changes mid-run is recorded with its own copy', async (t) => {
  /**
   * The goal used to pin this, and no longer changes the prompt at all, so the property is pinned by the mid-run
   * change that is left and is deliberate: approving a plan inside a run. That one *must* rewrite the prompt —
   * plan mode ends and the tools that write appear — and the record has to follow it rather than leave the second
   * round inheriting a hash for a prompt it was not sent.
   */
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      return round === 1
        ? toolCall('plan-1', 'exit_plan_mode', {
            title: 'Add the loader',
            summary: 'Two steps',
            steps: ['Write it', 'Test it'],
          })
        : reply('开始。');
    },
  };
  const approvePlan: Questioner = async () => ({
    answered: true,
    answers: [{ id: 'plan', selected: ['Approve and execute'] }],
  });
  const { store, sessionId, agent } = await fixture(t, provider, {}, { question: approvePlan });
  const plan = store.createPlan(sessionId);
  await agent.run({ sessionId, prompt: '规划 loader 的工作', planPhase: true, planId: plan.id });

  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes.length, 2, 'a record per round');
  assert.notEqual(
    envelopes[1]!.systemHash,
    envelopes[0]!.systemHash,
    'the prompt did change: the run may write now',
  );
  assert.equal(
    typeof recordsOf(store, sessionId)[1]!.data.system,
    'string',
    'so the round that was sent a different prompt carries its own copy',
  );
  assert.match(envelopes[0]!.system!, /Planning mode: you have read-only tools/);
  assert.match(envelopes[1]!.system!, /Read-only mode is over for this run/);
});

test('a goal written mid-run is said in the conversation, so the prompt is not rebuilt', async (t) => {
  /**
   * The prompt is the cacheable prefix — the system message and the whole tool catalogue — so anything that
   * rewrites it mid-run makes the model pay full price for a prefix it was sent one round earlier. The goal used
   * to be a section of it and a `create_goal` call rebuilt the prompt; it is a message now, appended where the
   * change happened, which leaves the prefix byte-identical and puts the news at the tail (see `goalNoticeText`).
   *
   * This is the same fixture as before, asserting the opposite outcome — and the notice still has to reach the
   * model, which is the half that makes the trade honest.
   */
  let round = 0;
  const sent: { system: string; messages: unknown[] }[] = [];
  const provider: Provider = {
    async complete(request) {
      sent.push({ system: request.system, messages: request.messages });
      round++;
      return round === 1
        ? toolCall('goal-1', 'create_goal', { objective: 'Ship the loader' })
        : reply('开始。');
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider);
  await agent.run({ sessionId, prompt: '开始 loader 的工作' });

  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes.length, 2, 'a record per round');
  assert.equal(
    envelopes[1]!.systemHash,
    envelopes[0]!.systemHash,
    'the goal is not part of the prompt any more, so the prefix did not change',
  );
  assert.equal(
    recordsOf(store, sessionId)[1]!.data.system,
    undefined,
    'and there is nothing to copy',
  );
  assert.doesNotMatch(envelopes[1]!.system!, /Session goal/);
  // The model was told: the notice arrives as a message of the second round, and it is the round's own state.
  const second = JSON.stringify(sent[1]!.messages);
  assert.match(second, /Session goal/);
  assert.match(second, /\[active\] Ship the loader \(1\/\d+ round/);
  assert.doesNotMatch(JSON.stringify(sent[0]!.messages), /Session goal/);
  // It is durable as a message too, so a reader of the transcript sees the same statement the model did.
  assert.ok(
    store.messages(sessionId).some((message) => String(message.content).includes('Session goal')),
  );
});

test('a goal announced at the start of a run does not make the next run’s prompt differ', async (t) => {
  /**
   * The other half of the same economy, and the bigger one: the notice states the goal's round count, so as a
   * section it made the system prompt differ on *every* round of a goal — each continuation is a new run with an
   * incremented count, so a 200-round goal re-sent the whole catalogue 200 times. Two runs of one goal now send
   * one prompt, twice.
   */
  let run = 0;
  const systems: string[] = [];
  const provider: Provider = {
    async complete(request) {
      systems.push(request.system);
      run++;
      return run === 1
        ? toolCall('goal-1', 'create_goal', { objective: 'Ship the loader', max_goal_rounds: 5 })
        : reply('开始。');
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider);
  await agent.run({ sessionId, prompt: '开始 loader 的工作' });
  await agent.run({ sessionId, prompt: '继续' });

  assert.equal(store.goal(sessionId)?.roundsStarted, 2, 'the second run was admitted to the goal');
  assert.equal(new Set(systems).size, 1, `one prompt for two runs: ${JSON.stringify(systems)}`);
  // And the conversation carries both notices, so "which round was this" is answerable from the transcript.
  const notices = store
    .messages(sessionId)
    .map((message) => String(message.content))
    .filter((content) => content.includes('Session goal'));
  assert.equal(notices.length, 2, 'one notice per run that owns the goal');
  assert.match(notices[1]!, /\(2\/5 round/);
});

test('a workspace whose instructions changed does not erase what the earlier run was told', async (t) => {
  // The case the record exists for: the file on disk is one thing, and what a past round was told is another.
  const files = { 'AGENTS.md': '# 旧规则\n\n- 第一条。\n' };
  const provider: Provider = {
    async complete() {
      return reply('好的。');
    },
  };
  const { root, store, sessionId, agent } = await fixture(t, provider, files);
  await agent.run({ sessionId, prompt: '第一轮' });
  await writeFile(path.join(root, 'AGENTS.md'), '# 新规则\n\n- 第二条。\n');
  const second = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
  });
  await second.run({ sessionId, prompt: '第二轮' });

  const envelopes = envelopesOf(store, sessionId);
  assert.equal(envelopes.length, 2);
  assert.match(envelopes[0]!.system!, /旧规则/);
  assert.match(envelopes[1]!.system!, /新规则/);
  assert.doesNotMatch(envelopes[1]!.system!, /旧规则/);
  assert.notEqual(envelopes[1]!.systemHash, envelopes[0]!.systemHash);
  // Both runs' prompts are still recoverable from the log, which is the whole point.
  const runIds = new Set(envelopes.map((envelope) => envelope.runId));
  assert.equal(runIds.size, 2, 'two runs, two identities');
});

test('a prompt too large to copy is recorded as a prefix and said to be one', () => {
  const system = 'x'.repeat(ENVELOPE_SYSTEM_CHARS + 100);
  const { envelope, systemHash } = envelopeEvent({
    runId: 'run-1',
    round: 3,
    system,
    tools: [{ name: 't', description: 'd', inputSchema: {} }],
    model: 'm',
    maxOutputTokens: 100,
  });
  assert.equal(envelope.systemTruncated, true);
  assert.equal(envelope.system!.length, ENVELOPE_SYSTEM_CHARS);
  assert.equal(envelope.systemBytes, ENVELOPE_SYSTEM_CHARS + 100, 'the true size is recorded');
  const folded = foldContextEnvelopes([
    { type: 'context.envelope', data: { ...envelope } },
    // A later round on the same prompt inherits both the prefix and the fact that it is one.
    { type: 'context.envelope', data: { ...envelope, round: 4, system: undefined } },
  ]);
  assert.equal(folded.length, 2);
  assert.equal(folded[1]!.system!.length, ENVELOPE_SYSTEM_CHARS);
  assert.equal(folded[1]!.systemTruncated, true);
  assert.equal(folded[1]!.systemHash, systemHash);
});

test('an envelope the reader cannot identify is refused rather than skipped', () => {
  // A record with no identity is not a smaller fact: an audit that quietly dropped it would look complete.
  assert.throws(
    () => foldContextEnvelopes([{ type: 'context.envelope', data: { round: 0 } }]),
    /corrupt/,
  );
  // Everything that is not an envelope is passed over, so the fold can be handed a whole log.
  assert.deepEqual(
    foldContextEnvelopes([
      { type: 'message.user', data: {} },
      { type: 'resources.loaded', data: { instructions: ['AGENTS.md'] } },
    ]),
    [],
  );
});
