/**
 * Executable invariants.
 *
 * Everything in this file is a promise the project already makes in its own documentation, turned into
 * something that fails loudly when the promise stops being true. These are deliberately cross-cutting
 * (they run whole scenarios and then assert a property of the *result*), unlike the per-feature suites
 * that each own one mechanism.
 *
 * The registry of invariants is this file: each one's number and exact scope is stated in the comment above the
 * test that enforces it (`I1` through `I9`). The runtime seam that lets any package publish an invariant of its
 * own is `packages/core/invariants.ts`, exercised by `tests/invariant-registry.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import { foldMessages } from '../packages/storage/events.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import { AGENT_EVENT_TYPES } from '../packages/protocol/index.ts';
import type {
  AgentEvent,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  RunResult,
  Usage,
} from '../packages/protocol/index.ts';
import { isSummaryRequest as isSharedSummaryRequest } from './summary-request.ts';
import { emptyRequestTiming, type SessionStatistics } from '../packages/protocol/statistics.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
/**
 * A request the context builder issues to summarise old history.
 *
 * Its mark is the summary instruction riding as the request's last message; the shared helper is what reads
 * it, so this file does not keep a second copy of the criterion.
 */
const isSummaryRequest = (request: ModelRequest) => isSharedSummaryRequest(request);

async function fixture(
  t: test.TestContext,
  provider: Provider,
  extra: Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invariants-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { root, store, session, agent, events, tools };
}
/**
 * I1 — model-visible ⇒ reconstructable from the store.
 *
 * Promise (`packages/core/context.ts`): the message history a request
 * carries is exactly the stored transcript from the persisted compaction boundary onward, and history
 * that was summarised away reaches the model only as the persisted summary. A future change that
 * injects model-visible content without persisting it would break every reader that reconstructs a
 * request from the database.
 */
test('I1: every request is a projection of the persisted transcript', async (t) => {
  const observations: Array<{
    system: string;
    messages: Message[];
    history: Message[];
    covered: number;
    summary: string;
  }> = [];
  const provider: Provider = {
    async complete(request) {
      if (isSummaryRequest(request)) return reply('Merged summary of all prior history.');
      observations.push({
        system: request.system,
        messages: request.messages,
        history: store.messages(session.id),
        covered: store.contextSurface(session.id)?.coveredMessages ?? 0,
        summary: store.contextSurface(session.id)?.summary ?? '',
      });
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return toolCall('read-1', 'read_file', { path: 'notes.txt' });
    },
  };
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invariant-i1-'));
  await writeFile(path.join(root, 'notes.txt'), 'seed\n');
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  // One hook on purpose: the database has to be closed before its directory can be removed.
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    // An empty registry on purpose: the character budget in this scenario measures the *message*
    // projection, and the real tool schemas (~22 KB) would dominate a small window on their own.
    // The kernel still installs its own run-scoped tools (session retrieval and the goal tools, ~6.7 KB of
    // schema), which is why the budget below is not the bare message size: it has to cover the system prompt
    // (~1.4 KB), those schemas and the transcript, or the run is refused before it can compact — and it has to
    // stay under 65% of that for the retained tail, or the compaction is refused as useless. The summary
    // request carries the same system prompt and schemas *plus* the instruction (~2 KB with the section
    // skeleton), so the batch it can hold is the budget minus roughly 10 KB rather than minus the old summary
    // prompt.
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 18_500,
  });
  // Enough history that the run has to summarise before it can continue, in *two* turns rather than one long
  // one: a summary batch must fit the same ceiling with the same fixed overhead, and a batch that is the whole
  // history minus only the instruction can never be inside a ceiling the whole history is outside of. Two
  // turns are what make "a batch of it fits while all of it does not" possible at all.
  store.append(session.id, { role: 'user', content: 'Earlier request. ' + 'x'.repeat(6000) });
  store.append(session.id, { role: 'assistant', content: 'Earlier answer.', toolCalls: [] });
  store.append(session.id, {
    role: 'user',
    content: 'Another earlier request. ' + 'y'.repeat(6000),
  });
  store.append(session.id, {
    role: 'assistant',
    content: 'Another earlier answer.',
    toolCalls: [],
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(observations.length >= 1, 'the provider must have been called at least once');
  assert.ok(
    observations.some((entry) => entry.covered > 0),
    'this scenario is meant to compact, so a checkpoint must exist',
  );
  for (const entry of observations) {
    /**
     * The projection rule, as the shape is now: the stored transcript from the checkpoint boundary, and — once
     * something has been compacted — the persisted summary in front of it.
     *
     * The summary is not an exception to the invariant; it *is* a projection of the log, of the
     * `context.compacted` event that recorded it. What the rule forbids is a request carrying a message nobody
     * can derive from the record, and this asserts that the one extra message is exactly the persisted summary.
     */
    const [first, ...rest] = entry.messages;
    const firstText = ((first as { content?: unknown } | undefined)?.content ?? '') as string;
    const snapshot = firstText.startsWith('<compacted-summary>');
    assert.deepEqual(
      snapshot ? rest : entry.messages,
      entry.history.slice(entry.covered),
      'a request carries exactly the stored transcript from the checkpoint boundary',
    );
    if (entry.covered > 0) {
      assert.equal(snapshot, true, 'a compacted request opens with the persisted summary');
      assert.match(
        firstText,
        new RegExp(entry.summary.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the summary shown to the model is the persisted one',
      );
      assert.doesNotMatch(
        entry.system,
        /<conversation_summary>|<compacted-summary>/,
        "and the prompt is the caller's own, unchanged by the compaction",
      );
    } else {
      assert.equal(snapshot, false, 'nothing has been compacted, so there is no snapshot');
      assert.doesNotMatch(entry.system, /<conversation_summary>/);
    }
  }
});

/**
 * I2 — every emitted event type is deliverable.
 *
 * Promise (`packages/client/host-client.ts`): the client's allow-list is derived from
 * `AGENT_EVENT_TYPES`, so an event type missing from that list is dropped silently for every consumer.
 * Nothing else guarantees the kernel only emits types the protocol declares.
 */
test('I2: the kernel only emits event types the protocol declares', async (t) => {
  let turn = 0;
  const provider: Provider = {
    async complete(request) {
      if (request.system.includes('You are a sub-agent delegated by a parent agent'))
        return reply('child report');
      turn++;
      if (turn === 1) return toolCall('read-1', 'read_file', { path: 'missing.txt' }); // an error result too
      if (turn === 2)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Check something' }],
        });
      return reply('Done');
    },
  };
  const { session, agent, events } = await fixture(t, provider, {
    // Delegation is off in the kernel by default, so a scenario that means to delegate must turn it on.
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  const declared = new Set<string>(AGENT_EVENT_TYPES);
  assert.ok(events.length > 10, 'the scenario must produce a real event stream');
  for (const event of events) {
    assert.ok(declared.has(event.type), `undeclared event type: ${event.type}`);
    // The client rejects a malformed event outright, so the kernel must never produce one.
    assert.equal(typeof event.sessionId, 'string');
    assert.ok(event.sessionId.length > 0);
    assert.equal(typeof event.runId, 'string');
    assert.ok(event.runId.length > 0);
    assert.equal(typeof event.data, 'object');
    assert.notEqual(event.data, null);
  }
  // The scenario is only meaningful if the interesting paths actually ran.
  assert.ok(events.some((event) => event.type === 'subagent.started'));
  assert.ok(events.some((event) => event.type === 'tool.finished' && event.data.isError === true));
});

/**
 * I3 — a run reports completion only after its resources are quiet.
 *
 * Promise (`README` 嵌入接口): the runtime aborts a hook that overruns and waits for it, and never
 * reports a finished run while cleanup is still executing. A late event after `run.finished` would
 * reach consumers that have already reconciled the session.
 */
test('I3: nothing is emitted after run.finished, and cleanup completes first', async (t) => {
  let closedAt = 0;
  const { session, agent, events, tools } = await fixture(t, {
    async complete() {
      return reply('Done');
    },
  });
  // The run owns the cleanups its own registry registered, and must finish them before reporting
  // completion. (An externally supplied HookRegistry is closed by its owner, not by the run.)
  tools.onClose(async () => {
    await sleep(150);
    closedAt = performance.now();
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do nothing' });
  const finishedAt = performance.now();
  assert.equal(result.status, 'completed', result.error);
  assert.ok(closedAt > 0, 'the registered cleanup must have run');
  assert.ok(closedAt < finishedAt, 'cleanup must finish before the run reports completion');
  const finishedIndex = events.findIndex((event) => event.type === 'run.finished');
  assert.ok(finishedIndex >= 0, 'the run must report its completion');
  assert.equal(events.at(-1)?.type, 'run.finished', 'nothing may be emitted after completion');
  await sleep(250);
  assert.equal(events.length, finishedIndex + 1, 'no late events after completion');
  assert.equal(events.at(-1)?.type, 'run.finished');
});

/**
 * I4 — no run outcome leaves work marked as running.
 *
 * Promise (`README` 会话/子代理, `packages/storage/sqlite.ts` `reconcileChildRuns`, `beginRun`'s guard):
 * a session that is not running must not claim an active run, and a delegated child must never be left
 * locked behind its parent. `reconcileChildRuns` exists precisely to clean up what a crash leaves, so
 * a *normal* outcome must leave nothing for it to find.
 */
test('I4: completed, cancelled and failed runs leave no running rows or locked sessions', async (t) => {
  const outcomes: Array<{
    name: string;
    provider: Provider;
    signal?: () => AbortSignal;
    expect: string;
  }> = [
    {
      name: 'completed',
      provider: {
        async complete(request) {
          if (request.system.includes('You are a sub-agent delegated by a parent agent'))
            return reply('child report');
          if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
          return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
        },
      },
      expect: 'completed',
    },
    {
      name: 'cancelled',
      provider: {
        async complete(request) {
          if (request.system.includes('You are a sub-agent delegated by a parent agent'))
            return new Promise<ModelResponse>((_resolve, reject) =>
              request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              }),
            );
          if (request.messages.some((message) => message.role === 'tool'))
            return new Promise<ModelResponse>((_resolve, reject) =>
              request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              }),
            );
          return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
        },
      },
      signal: () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);
        return controller.signal;
      },
      expect: 'cancelled',
    },
    {
      name: 'failed',
      provider: {
        async complete(request) {
          if (request.system.includes('You are a sub-agent delegated by a parent agent'))
            return reply('child report');
          if (request.messages.some((message) => message.role === 'tool'))
            throw new Error('provider exploded');
          return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
        },
      },
      expect: 'failed',
    },
  ];
  for (const scenario of outcomes) {
    const { root, store, session, agent } = await fixture(t, scenario.provider, {
      subagents: { enabled: true },
    });
    const result = await agent.run({
      sessionId: session.id,
      prompt: 'Do the work',
      ...(scenario.signal ? { signal: scenario.signal() } : {}),
    });
    assert.equal(result.status, scenario.expect, `${scenario.name}: unexpected run status`);
    const children = store.childSessions(session.id);
    assert.ok(children.length >= 1, `${scenario.name}: the scenario must have delegated`);
    for (const id of [session.id, ...children.map((child) => child.id)]) {
      assert.equal(
        store.get(id).activeRun,
        null,
        `${scenario.name}: ${id} still claims an active run`,
      );
    }
    const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
    const leaked = db
      .prepare(
        `SELECT id FROM runs WHERE status='running' AND session_id IN (${[session.id, ...children.map((child) => child.id)].map(() => '?').join(',')})`,
      )
      .all(session.id, ...children.map((child) => child.id));
    db.close();
    assert.deepEqual(leaked, [], `${scenario.name}: a run row was left running`);
  }
});

/**
 * I5 — a run changes what it says it changed, and nothing else.
 *
 * Promise (`README` 会话改动与撤销, the audit's "verify the world"): tool effects are journalled, so the
 * set of files that differ after a run must equal the set of changes the run recorded. This catches a
 * tool that rewrites, truncates or creates something incidental — the failure mode a session-level
 * "changes" list would otherwise hide.
 */
test('I5: only the files a run reports as changed actually differ afterwards', async (t) => {
  const { root, store, session, agent } = await fixture(t, {
    async complete(request) {
      // Read first: the change gate refuses an edit of a file this run has not read, and this invariant needs a
      // real change to have happened before it can say the journal matches the world.
      const results = request.messages.filter((message) => message.role === 'tool');
      if (results.length === 0) return toolCall('read-1', 'read_file', { path: 'src/a.txt' });
      if (results.length === 1)
        return toolCall('edit-1', 'edit_file', {
          path: 'src/a.txt',
          old_text: 'old',
          new_text: 'new',
        });
      return reply('Edited');
    },
  });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const seeded: Record<string, string> = {
    'src/a.txt': 'old\n',
    'src/b.txt': 'untouched\n',
    'docs/readme.md': '# untouched\n',
    'data.bin': 'binary-ish\u0000content',
    '.hidden': 'hidden untouched\n',
  };
  for (const [name, content] of Object.entries(seeded))
    await writeFile(path.join(root, name), content);

  const hashTree = async (): Promise<Record<string, string>> => {
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name === '.yuantu') continue; // the session database is not a product artifact
        // The store's own files (database plus WAL/SHM sidecars) are runtime state, not artifacts.
        if (/^sessions\.sqlite(-wal|-shm)?$/.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else files.push(full);
      }
      return files;
    };
    const files = await walk(root);
    const result: Record<string, string> = {};
    for (const file of files)
      result[path.relative(root, file).replace(/\\/g, '/')] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    return result;
  };

  const before = await hashTree();
  const result = await agent.run({ sessionId: session.id, prompt: 'Edit the file' });
  assert.equal(result.status, 'completed', result.error);
  const after = await hashTree();
  const recorded = store
    .fileChanges(session.id)
    .map((change) => change.change.path.replace(/\\/g, '/'))
    .sort();
  const actuallyDifferent = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort();
  assert.deepEqual(actuallyDifferent, ['src/a.txt'], 'only the edited file may differ');
  assert.deepEqual(recorded, actuallyDifferent, 'the change journal must match the world');
  assert.equal(await readFile(path.join(root, 'src/a.txt'), 'utf8'), 'new\n');
});

/**
 * I6 — a refused approval produces no effect, for every permission class.
 *
 * Promise (`README` 权限、审批与沙箱): file writes, command execution and external access are each
 * asked for item by item, and a refusal is final. This is the property that makes the whole approval
 * surface meaningful, and it is checked here for one representative tool per class.
 */
test('I6: refusing approval leaves no file, no command effect and no external call', async (t) => {
  const { root, tools } = await fixture(t, {
    async complete() {
      return reply();
    },
  });
  const asked: string[] = [];
  const approve = async (approval: { kind: string }) => {
    asked.push(approval.kind);
    return false;
  };
  const signal = new AbortController().signal;
  const write = await tools.execute(
    { id: 'w', name: 'write_file', arguments: { path: 'denied.txt', content: 'nope' } },
    { signal, approve },
  );
  assert.equal(write.isError, true);
  await assert.rejects(readFile(path.join(root, 'denied.txt')), { code: 'ENOENT' });

  const command = await tools.execute(
    {
      id: 'c',
      name: 'run_command',
      arguments: { command: "node -e \"require('fs').writeFileSync('command-marker.txt','x')\"" },
    },
    { signal, approve },
  );
  assert.equal(command.isError, true);
  await assert.rejects(readFile(path.join(root, 'command-marker.txt')), { code: 'ENOENT' });

  const external = await tools.execute(
    { id: 'e', name: 'web_fetch', arguments: { url: 'http://127.0.0.1:9/never' } },
    { signal, approve },
  );
  assert.equal(external.isError, true);
  assert.deepEqual(asked, ['write', 'command', 'external'], 'every class must have asked first');
});

/**
 * I7 — context injected by policy is logged, not smuggled.
 *
 * Promise (README 工具执行管线 / 生命周期钩子): an extension can add model-visible context, either to a
 * tool call (`post-execute` `add-context`) or to a round (`pre-step` `inject`). The tempting
 * implementation is to append it to whatever text is already there — the tool result, or the user
 * prompt — which would make the transcript claim the tool printed something it never printed, and put
 * text outside the summary and the compaction boundary. Each injection must instead become a persisted
 * message of its own, in the position it belongs to, so the "model-visible ⇒ in the transcript" rule
 * that I1 checks for the request also holds for context a policy adds.
 */
test('I7: injected context is persisted, positioned and seen by the model', async (t) => {
  const requests: Message[][] = [];
  const provider: Provider = {
    async complete(request) {
      if (isSummaryRequest(request)) return reply('Summary of prior history.');
      requests.push(request.messages);
      const injected = request.messages.some(
        (message) => message.role === 'user' && message.content.includes('INJECTED-NOTE'),
      );
      return injected ? reply('Done') : toolCall('read-1', 'read_file', { path: 'notes.txt' });
    },
  };
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invariant-i7-'));
  await writeFile(path.join(root, 'notes.txt'), 'seed\n');
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context) =>
      context.round === 0
        ? { inject: ['PRE-STEP-NOTE: this workspace is treated as read-only for now.'] }
        : undefined,
    postExecute: (execution, result) =>
      execution.tool === 'read_file' && !result.isError
        ? {
            action: 'add-context',
            context: 'INJECTED-NOTE: this file is generated, do not edit it.',
          }
        : undefined,
  });
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read the notes' });
  assert.equal(result.status, 'completed', result.error);

  const messages = store.messages(session.id);
  const injected = messages.filter(
    (message) => message.role === 'user' && message.content.includes('INJECTED-NOTE'),
  );
  assert.equal(injected.length, 1, 'the injection is persisted exactly once');
  const toolIndex = messages.findIndex((message) => message.role === 'tool');
  const injectedIndex = messages.findIndex(
    (message) => message.role === 'user' && message.content.includes('INJECTED-NOTE'),
  );
  assert.ok(toolIndex >= 0, 'the scenario must have executed a tool');
  assert.ok(injectedIndex > toolIndex, 'injected context follows the tool results it belongs to');
  assert.ok(
    requests.some((batch) =>
      batch.some((message) => message.role === 'user' && message.content.includes('INJECTED-NOTE')),
    ),
    'the model must actually see the injected context',
  );

  // The round preamble injects the same way, in the position that belongs to a round: after the user
  // prompt it annotates, and before any model or tool output for that round.
  const preamble = messages.filter((message) => message.content.includes('PRE-STEP-NOTE'));
  assert.equal(preamble.length, 1, 'the preamble note is persisted exactly once');
  const preambleIndex = messages.findIndex((message) => message.content.includes('PRE-STEP-NOTE'));
  const firstAssistant = messages.findIndex((message) => message.role === 'assistant');
  assert.ok(preambleIndex > 0, 'it follows the prompt it belongs to');
  assert.ok(preambleIndex < firstAssistant, 'and precedes the round it was injected for');
  assert.ok(
    requests[0]?.some((message) => message.content.includes('PRE-STEP-NOTE')),
    'the first request of the run carries it',
  );

  const announced = events.filter((event) => event.type === 'context.injected');
  assert.deepEqual(
    announced.map((event) => event.data.source),
    ['pre-step', 'post-execute'],
    'both seams announce their injection, in the order they happened',
  );
  assert.ok(
    announced.every((event) => event.data.notes === 1),
    'each injection reports how many notes it carried',
  );
  assert.ok(
    (AGENT_EVENT_TYPES as readonly string[]).includes('context.injected'),
    'the announced type must be declared (I2)',
  );
});

/**
 * I8 — the transcript is exactly the fold of the durable log.
 *
 * Promise (README 会话、恢复与撤销; `packages/storage/events.ts`): a session's durable facts are appended
 * as events, and the message history a reader gets is the fold of those events. The failure this catches
 * is a *divergence between views*: a durable fact written to one place but not the other, so that the
 * transcript the model is given, the transcript the UI renders and the rows on disk stop being the same
 * history. It is checked here for the parent and for a delegated child, and against a second, independent
 * connection to the database — the same way a reviewer would check it by hand.
 */
test('I8: every session transcript is exactly the fold of its durable log', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (request.system.includes('You are a sub-agent delegated by a parent agent'))
        return reply('child report');
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
    },
  };
  const { root, store, session, agent } = await fixture(t, provider, {
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);

  const children = store.childSessions(session.id);
  assert.ok(children.length >= 1, 'the scenario must have delegated, so two logs exist');
  // Closed before the test returns: the fixture's teardown removes the directory, and node runs `after`
  // hooks in registration order, so a connection left open here is an EBUSY on Windows.
  const reader = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  try {
    for (const id of [session.id, ...children.map((child) => child.id)]) {
      const events: SessionEvent[] = store.events(id);
      const messages = store.messages(id);
      assert.deepEqual(
        foldMessages(events),
        messages,
        `${id}: the projection is the fold of the log`,
      );
      assert.deepEqual(
        reader
          .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
          .all(id)
          .map((row) => JSON.parse(String(row.body)) as Message),
        messages,
        `${id}: the rows on disk say the same thing as the log`,
      );
      // The run lifecycle is in the log too, and it is not transcript content.
      const types = events.map((event) => event.type);
      assert.ok(types.includes('run.started'), `${id}: the run is recorded`);
      assert.ok(
        types.lastIndexOf('run.finished') > types.indexOf('run.started'),
        `${id}: the run finishes after it starts`,
      );
      assert.equal(
        messages.length,
        types.filter((type) => type.startsWith('message.')).length,
        `${id}: every message event contributes exactly one message, and nothing else does`,
      );
    }
  } finally {
    reader.close();
  }
});

/**
 * I9 — a session's views are folds of its log, not separate tallies.
 *
 * Promise (README 会话日志与投影; `packages/storage/projections.ts`): statistics, the transcript and whatever
 * else a reader asks for are projections of the durable log, so a view cannot quietly be accumulated
 * somewhere else and drift from the record. The failure this catches is a reader that keeps working while
 * the log is incomplete — a `run.finished` event whose payload was never written, a projection that reads a
 * table instead, or a snapshot whose entries disagree with the individual reads.
 *
 * The expected value here is computed from the write-through `runs` rows by the test itself, so the two
 * sides are genuinely independent: the log fold and the table fold have to agree.
 */
test('I9: session views are folds of the log, and they agree with the write-through tables', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (request.system.includes('You are a sub-agent delegated by a parent agent'))
        return reply('child report');
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
    },
  };
  const { root, store, session, agent } = await fixture(t, provider, {
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  const children = store.childSessions(session.id);
  assert.ok(
    children.length >= 1,
    'the scenario must have delegated, so more than one run finished',
  );

  const reader = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  try {
    for (const id of [session.id, ...children.map((child) => child.id)]) {
      // The table's answer, computed here: sum each finished run's statistics, or its usage when the run
      // predates statistics, marking timing unknown exactly as the recorded result does.
      const expected: SessionStatistics = {
        turns: 0,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheKnown: true,
        timingKnown: true,
        usageComplete: true,
        modelMs: 0,
        toolMs: 0,
        firstTokenMs: 0,
        firstTokenCount: 0,
        decodeMs: 0,
        decodeTokens: 0,
      };
      const rows = reader
        .prepare('SELECT result FROM runs WHERE session_id=? AND result IS NOT NULL')
        .all(id);
      assert.ok(rows.length >= 1, `${id}: the scenario finished at least one run`);
      for (const row of rows) {
        const run = JSON.parse(String(row.result)) as {
          usage: Usage;
          statistics?: typeof expected;
        };
        if (run.statistics) {
          const part = run.statistics;
          expected.turns += part.turns;
          expected.steps += part.steps;
          expected.inputTokens += part.inputTokens;
          expected.outputTokens += part.outputTokens;
          expected.cachedInputTokens += part.cachedInputTokens;
          expected.cacheWriteInputTokens += part.cacheWriteInputTokens ?? 0;
          expected.cacheKnown = expected.cacheKnown && part.cacheKnown;
          expected.timingKnown = expected.timingKnown && part.timingKnown;
          expected.usageComplete = expected.usageComplete && part.usageComplete;
          expected.modelMs += part.modelMs;
          expected.toolMs += part.toolMs;
          expected.firstTokenMs += part.firstTokenMs;
          expected.firstTokenCount += part.firstTokenCount;
          expected.decodeMs += part.decodeMs;
          expected.decodeTokens += part.decodeTokens;
          if (part.decodeKnown !== undefined)
            expected.decodeKnown = expected.decodeKnown !== false && part.decodeKnown;
          if (part.requestTiming) {
            const timing = (expected.requestTiming ??= emptyRequestTiming());
            for (const key of Object.keys(timing) as (keyof typeof timing)[])
              timing[key] += part.requestTiming[key];
          }
          continue;
        }
        // A run that predates statistics contributes its usage, and marks timing unknown.
        expected.inputTokens += run.usage.inputTokens;
        expected.outputTokens += run.usage.outputTokens;
        expected.cachedInputTokens += run.usage.cachedInputTokens ?? 0;
        expected.cacheWriteInputTokens += run.usage.cacheWriteInputTokens ?? 0;
        if (run.usage.inputTokens > 0 && run.usage.cachedInputTokens === undefined)
          expected.cacheKnown = false;
        expected.timingKnown = false;
      }
      assert.deepEqual(
        store.statistics(id),
        expected,
        `${id}: the statistics projection equals the runs table`,
      );
      const snapshot = store.snapshot(id) as { messages: Message[]; statistics: unknown };
      assert.deepEqual(
        snapshot.messages,
        store.messages(id),
        `${id}: the snapshot carries the transcript`,
      );
      assert.deepEqual(
        snapshot.statistics,
        store.statistics(id),
        `${id}: one pass folds the same state`,
      );
      assert.deepEqual(
        store.stateOf<Message[]>('messages', id),
        store.messages(id),
        `${id}: the named projection is the read`,
      );
      // The sub-agent cards are a projection too: they must be exactly what the stored run result says,
      // which is where the desktop read them from before the log carried them. The work time is the one
      // field the result cannot carry — it belongs to the child's own log — so it is computed here from that
      // child's own run boundaries, which is the same independent arithmetic the fold claims to do.
      const latest = reader
        .prepare(
          'SELECT result FROM runs WHERE session_id=? AND result IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1',
        )
        .get(id);
      const reported = latest
        ? ((JSON.parse(String(latest.result)) as RunResult).subagents ?? [])
        : [];
      const expectedCards = reported.map((card) => {
        const boundaries = reader
          .prepare(
            "SELECT type,data,at FROM session_events WHERE session_id=? AND type IN ('run.started','run.finished','run.interrupted') ORDER BY seq",
          )
          .all(card.sessionId) as { type: string; data: string; at: string }[];
        let settledMs = 0;
        let runningSince: number | null = null;
        for (const boundary of boundaries) {
          if (boundary.type === 'run.started') {
            runningSince = Date.parse(boundary.at);
            continue;
          }
          if (runningSince === null) continue;
          settledMs += Math.max(0, Date.parse(boundary.at) - runningSince);
          runningSince = null;
        }
        return { ...card, durationMs: settledMs, runningSince };
      });
      assert.deepEqual(
        store.subagents(id),
        expectedCards,
        `${id}: the cards are the sub-agents the run reported`,
      );
    }
  } finally {
    reader.close();
  }
});
