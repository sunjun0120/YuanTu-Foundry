import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { createTools } from '../packages/catalog/index.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';
import { git } from './git-fixture.ts';

/**
 * Delegation with isolated directories.
 *
 * The property these cases hold the delegation seam to is the one a user can observe: two write-capable children
 * running at the same time read and write the *same* file, and neither sees the other's bytes — while the
 * delegator's own directory keeps whatever it had. Everything else here (which mode shares, what a fork inherits,
 * how a refusal is reported) follows from that.
 */

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const delegate = (tasks: unknown[], wait?: boolean): ModelResponse => ({
  text: 'Delegating',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: 'delegate-1',
      name: 'delegate_task',
      arguments: { tasks, ...(wait === undefined ? {} : { wait }) },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const callTool = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const report = (summary: string): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: `report-${summary}`,
      name: 'submit_report',
      arguments: { summary, findings: [{ statement: summary, evidence: 'observed' }] },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const isChild = (request: ModelRequest): boolean =>
  request.system.includes('You are a sub-agent delegated by a parent agent');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the body with the host execution mode in force.
 *
 * A real file write has to go through the tool pipeline, and the pipeline refuses to run at all unless the
 * declared backend can say what it permits — on a machine with no verified native sandbox that is no backend at
 * all. Host mode is the honest answer for a test that is about *where* a write lands rather than about what
 * confines it, and it is restored afterwards so the next file in the run sees the environment it expects.
 */
async function inHostMode<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'host';
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
  }
}
interface Harness {
  root: string;
  store: SessionStore;
  sessionId: string;
  manager: WorkspaceManager;
  close(): Promise<void>;
}

/**
 * A real repository, a real store and a real manager, with the delegation seam wired the way `createAgent` wires
 * it: `childTools` builds a registry at the child's own execution root, and `workspaceRoots` resolves it per call.
 */
async function harness(
  t: test.TestContext,
  options: { mode?: 'auto' | 'shared' | 'worktree'; metadataWrites?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagent-ws-'));
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  const manager = new WorkspaceManager({
    store,
    ...(options.metadataWrites === false ? { metadataWritesAllowed: () => false } : {}),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'same.txt'), 'base\n');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  const session = store.create(root);
  return {
    root,
    store,
    sessionId: session.id,
    manager,
    async close() {
      /* Cleanup is registered on the test context. */
    },
  };
}

/** One agent over one session, with the isolation seams wired exactly as `apps/shared/runtime.ts` wires them. */
function agentFor(
  harness: Harness,
  provider: Provider,
  options: {
    mode?: 'auto' | 'shared' | 'worktree';
    events?: unknown[];
    childRegistries?: ToolRegistry[];
    /** Delegation limits, for the case that has to observe queuing rather than parallelism. */
    subagents?: { maxConcurrency?: number; maxPerRun?: number };
  } = {},
): Agent {
  return new Agent({
    store: harness.store,
    provider,
    tools: createTools(harness.root),
    approve: async () => true,
    subagents: { enabled: true, ...options.subagents },
    workspaceMode: options.mode ?? 'auto',
    workspaceManager: harness.manager,
    childTools: (binding) => {
      const registry = createTools(binding?.executionRoot ?? harness.root);
      options.childRegistries?.push(registry);
      return registry;
    },
    workspaceRoots: (sessionId) => {
      const binding = harness.manager.resolve(sessionId);
      return { projectRoot: binding.projectRoot, executionRoot: binding.executionRoot };
    },
    ...(options.events ? { onEvent: (event: unknown) => options.events!.push(event) } : {}),
  });
}

test('two general children edit the same file without seeing each other', async (t) => {
  const h = await harness(t);
  /**
   * Both children write, then read back what they wrote, then report it.
   *
   * The read-back is the part that matters: two children could easily be handed two directories and still be
   * pointed at one tree by the tools they were given, and only reading the file *through the child's own tools*
   * tells the difference.
   */
  const seen: Record<string, string> = {};
  /**
   * Which round each child is on, keyed by objective.
   *
   * A single counter would be a race rather than a measurement: the two children interleave, and a global count that
   * happened to land on eight could also mean one child took five rounds and the other three. The number of rounds is
   * derived per child so the assertion below is about *each* child finishing its sequence.
   */
  const rounds: Record<string, number> = {};
  const inFlight: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool'))
          return reply('Both children reported');
        return delegate([
          { objective: 'Write alpha', role: 'general', context: 'Write "alpha" into same.txt' },
          { objective: 'Write beta', role: 'general', context: 'Write "beta" into same.txt' },
        ]);
      }
      const prompt = String(request.messages[0]?.content ?? '');
      const which = prompt.includes('alpha') ? 'alpha' : 'beta';
      const own = (rounds[which] = (rounds[which] ?? 0) + 1);
      if (own === 1) {
        inFlight.push(which);
        // Both children are inside their first round at once, which is what makes the overlap real.
        await sleep(30);
        // Read first, then write: the file gate wants the bytes seen in this run before it will change them, which
        // is exactly the discipline the child's own tools enforce.
        return callTool(`${which}-0`, 'read_file', { path: 'same.txt' });
      }
      if (own === 2)
        return callTool(`${which}-1`, 'edit_file', {
          path: 'same.txt',
          old_text: 'base\n',
          new_text: `${which}\n`,
        });
      if (own === 3) return callTool(`${which}-2`, 'read_file', { path: 'same.txt' });
      // The tool result that follows the second read is what the child actually has on disk.
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      const last = String(toolMessages[toolMessages.length - 1]?.content ?? '');
      seen[which] = last;
      inFlight.splice(inFlight.indexOf(which), 1);
      return report(`${which} saw ${JSON.stringify(last.slice(0, 40))}`);
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Do both' }));
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(rounds, { alpha: 4, beta: 4 }, 'each child read, wrote, read back and reported');
  // Each child read its own bytes back: neither saw the other's write, which is the guarantee isolation is for.
  assert.match(seen.alpha!, /alpha/);
  assert.match(seen.beta!, /beta/);
  assert.doesNotMatch(seen.alpha!, /beta/);
  assert.doesNotMatch(seen.beta!, /alpha/);
  // The delegator's own file is exactly as it was.
  assert.equal(await readFile(path.join(h.root, 'same.txt'), 'utf8'), 'base\n');
  // The parent's change list holds none of it: a child's work is not the parent's change until it is imported.
  assert.deepEqual(h.store.fileChanges(h.sessionId), []);
  // Each child was given its own directory, recorded durably, and its session belongs to the same project.
  const bindings = h.store.workspaceBindingsByState(['ready']);
  assert.equal(bindings.length, 2);
  assert.notEqual(bindings[0]!.executionRoot, bindings[1]!.executionRoot);
  for (const binding of bindings) {
    assert.equal(binding.kind, 'worktree');
    assert.equal(binding.projectRoot, h.root);
    assert.equal(h.store.get(binding.sessionId!).workspace, h.root);
  }
});

test('a read-only child shares the delegator directory, and has no write tool', async (t) => {
  const h = await harness(t);
  let childTurns = 0;
  let writeToolsOffered: string[] = [];
  let attemptResult = '';
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Read done');
        return delegate([{ objective: 'Look around' }]);
      }
      childTurns++;
      /**
       * What the *model* is offered is the read-only promise; what a call is answered with is a second one.
       *
       * The first is the guarantee (a write tool that is not on the list is not callable at all, rather than
       * refused after the fact), and the second is what a model that tries anyway is told. Both are asserted,
       * because a child that was merely refused would still have spent a round discovering it.
       */
      writeToolsOffered = (request.tools ?? [])
        .map((tool) => tool.name)
        .filter((name) => name === 'write_file' || name === 'edit_file' || name === 'delete_file');
      if (childTurns === 1)
        return callTool('w-1', 'edit_file', {
          path: 'same.txt',
          old_text: 'base\n',
          new_text: 'nope\n',
        });
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      attemptResult = String(toolMessages[toolMessages.length - 1]?.content ?? '');
      return report('read only');
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Look' }));
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(writeToolsOffered, [], 'a read-only child is not offered a write tool');
  assert.match(attemptResult, /Unknown tool|not available|has not been read/i);
  assert.equal(await readFile(path.join(h.root, 'same.txt'), 'utf8'), 'base\n');
  // A shared child gets the delegator's binding, and no worktree is created for it.
  assert.deepEqual(h.store.workspaceBindingsByState(['ready']), []);
  const childEvents = h.store
    .events(h.sessionId)
    .filter((event) => event.type === 'subagent.assigned');
  assert.equal(childEvents.length, 1);
});

test('a fork follows the same isolation rule as a delegation', async (t) => {
  const h = await harness(t);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Fork done');
        return callTool('fork-1', 'subagent_fork', {
          tasks: [{ objective: 'Continue from here', role: 'general' }],
        });
      }
      if (request.messages.some((message) => message.role === 'tool')) return report('forked');
      return callTool('f-1', 'write_file', { path: 'fork.txt', content: 'from the fork\n' });
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Fork it' }));
  assert.equal(result.status, 'completed', result.error);
  // The fork inherited the transcript *and* was isolated: inheriting context never changes where writes land.
  const bindings = h.store.workspaceBindingsByState(['ready']);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.kind, 'worktree');
  assert.equal(
    await readFile(path.join(h.root, 'fork.txt'), 'utf8').catch(() => 'absent'),
    'absent',
  );
  assert.equal(
    await readFile(path.join(bindings[0]!.executionRoot, 'fork.txt'), 'utf8'),
    'from the fork\n',
  );
});

test('tasks queued behind the concurrency cap share the snapshot the first one used', async (t) => {
  const h = await harness(t);
  /**
   * Three children, one slot.
   *
   * The parent's own file changes *between* the children's starts — which is the situation the whole
   * one-snapshot-per-call rule exists for. If each child froze its input when it happened to start, the later ones
   * would see the new bytes and their results would be diffs against different trees; if they share the baseline,
   * all three see `base`.
   */
  const seen: string[] = [];
  /** Turns per child, keyed by objective: the three children interleave, so one counter would not say whose turn it is. */
  const turns = new Map<string, number>();
  let started = 0;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('All done');
        return delegate([
          { objective: 'Read it one', role: 'general' },
          { objective: 'Read it two', role: 'general' },
          { objective: 'Read it three', role: 'general' },
        ]);
      }
      const prompt = String(request.messages[0]?.content ?? '');
      const mine = ['one', 'two', 'three'].find((word) => prompt.includes(` ${word}`)) ?? 'one';
      const turn = (turns.get(mine) ?? 0) + 1;
      turns.set(mine, turn);
      if (turn === 1) {
        started++;
        // The first child to run changes the delegator's file while the others are still queued.
        if (started === 1) await writeFile(path.join(h.root, 'same.txt'), 'changed under them\n');
        return callTool(`q-${mine}`, 'read_file', { path: 'same.txt' });
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      seen.push(String(toolMessages[toolMessages.length - 1]?.content ?? ''));
      return report(`child ${mine}`);
    },
  };
  const agent = agentFor(h, provider, {
    mode: 'worktree',
    subagents: { maxConcurrency: 1, maxPerRun: 3 },
  });
  const result = await inHostMode(() =>
    agent.run({ sessionId: h.sessionId, prompt: 'Read it three times' }),
  );
  assert.equal(result.status, 'completed', result.error);
  assert.equal(seen.length, 3);
  for (const content of seen) assert.match(content, /base/, 'every child saw the frozen baseline');
  // One snapshot, shared by all three: the plan's "one frozen input per call".
  assert.equal(h.store.workspaceSnapshots().length, 1);
  const bindings = h.store.workspaceBindingsByState(['ready']);
  assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings.map((binding) => binding.snapshotId)).size, 1);
});

test('an explicit shared mode keeps the pre-isolation behaviour', async (t) => {
  const h = await harness(t);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Wrote it');
        return delegate([{ objective: 'Write it', role: 'general' }]);
      }
      if (request.messages.some((message) => message.role === 'tool')) return report('wrote');
      return callTool('s-1', 'write_file', { path: 'shared.txt', content: 'shared\n' });
    },
  };
  const agent = agentFor(h, provider, { mode: 'shared' });
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Write it' }));
  assert.equal(result.status, 'completed', result.error);
  // The write landed in the delegator's directory and in the delegator's journal, which is exactly what `shared`
  // means and what the plan refuses to call isolation.
  assert.equal(await readFile(path.join(h.root, 'shared.txt'), 'utf8'), 'shared\n');
  assert.equal(h.store.workspaceBindingsByState(['ready']).length, 0);
  assert.equal(h.store.workspaceSnapshots().length, 0);
  const changes = h.store.fileChanges(h.sessionId);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.change.path, 'shared.txt');
});

test('a policy that cannot manage Git metadata refuses the task instead of degrading', async (t) => {
  const h = await harness(t, { metadataWrites: false });
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Refused');
        return delegate([{ objective: 'Write it', role: 'general' }]);
      }
      return report('should never run');
    },
  };
  const agent = agentFor(h, provider, { mode: 'auto' });
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Write it' }));
  assert.equal(result.status, 'completed', result.error);
  // No child session, no directory, no snapshot: a refusal that happens before anything exists is the only kind
  // that cannot leave a run whose writes have nowhere to go.
  assert.equal(h.store.childSessions(h.sessionId).length, 0);
  assert.deepEqual(h.store.workspaceSnapshots(), []);
  assert.deepEqual(h.store.workspaceBindingsByState(['preparing', 'ready', 'blocked']), []);
  const content = h.store
    .messages(h.sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
  // The refusal is reported rather than silently becoming a shared write, and it says what was missing.
  assert.match(content, /WORKSPACE_POLICY_UNSUPPORTED/);
  assert.equal(await readFile(path.join(h.root, 'same.txt'), 'utf8'), 'base\n');
});

test('a repository that cannot be frozen refuses the isolated task and leaves the read-only ones alone', async (t) => {
  const h = await harness(t);
  // A tracked credential blocks a freeze; a read-only task under `auto` never freezes anything, so it still runs.
  await writeFile(path.join(h.root, '.env'), 'SECRET=1\n');
  git(h.root, ['add', '-f', '.env']);
  git(h.root, ['commit', '-qm', 'credentials']);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Explored');
        return delegate([{ objective: 'Look around' }]);
      }
      return report('looked');
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Look' }));
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(h.store.workspaceSnapshots(), []);
  assert.equal(h.store.childSessions(h.sessionId).length, 1, 'the read-only child still ran');
});

test('the child’s registry is built at its own execution root, not the delegator’s', async (t) => {
  const h = await harness(t);
  const registries: ToolRegistry[] = [];
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'Write it', role: 'general' }]);
      }
      if (request.messages.some((message) => message.role === 'tool')) return report('wrote');
      // At the worktree root: `write_file` refuses to create parent directories, and that is its own rule rather
      // than anything about isolation.
      return callTool('r-1', 'write_file', { path: 'inside.txt', content: 'inside\n' });
    },
  };
  const agent = agentFor(h, provider, { childRegistries: registries });
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Write it' }));
  assert.equal(result.status, 'completed', result.error);
  const binding = h.store.workspaceBindingsByState(['ready'])[0]!;
  assert.equal(registries.length, 1);
  // The registry's own root is the child's directory: this is what makes every tool bound at construction — files,
  // commands, language servers, spill — address the copy rather than the original.
  assert.equal(registries[0]!.workspaceRoot, binding.executionRoot);
  assert.notEqual(registries[0]!.workspaceRoot, h.root);
  // The write went into the child's directory and not the parent's.
  assert.equal(await readFile(path.join(binding.executionRoot, 'inside.txt'), 'utf8'), 'inside\n');
  assert.equal(
    await readFile(path.join(h.root, 'inside.txt'), 'utf8').catch(() => 'absent'),
    'absent',
  );
});

test('a directory that was replaced after allocation is refused rather than used', async (t) => {
  const h = await harness(t);
  let calls = 0;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'Write it', role: 'general' }]);
      }
      calls++;
      return report('wrote');
    },
  };
  const agent = agentFor(h, provider);
  await mkdir(path.join(h.root, 'untouched'), { recursive: true });
  const result = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'Write it' }));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(calls, 1);
  // Validation ran as part of the delegation and accepted the directory it created; the refusal path for a
  // replaced directory is covered by `tests/workspace-manager.test.ts`, which can simulate the replacement
  // without racing the delegation.
  const binding = h.store.workspaceBindingsByState(['ready'])[0]!;
  await h.manager.validate(binding, new AbortController().signal);
});
