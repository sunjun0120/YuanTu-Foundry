import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService, isUtf8Text } from '../packages/workspaces/results.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

/**
 * Freezing what a child produced.
 *
 * The property under test is that a result describes *the child's directory at the end of its turn*, against the
 * input it started from — not against whatever the parent's directory holds, and not against what the child said it
 * did. Three consequences are checked here and each has its own failure mode: a command's side effects must be
 * visible (a result read from a file-tool journal would miss them), the parent's own files and journal must be
 * untouched (a result that leaked would make the parent's undo write into a tree it does not have), and a follow-up
 * must not silently replace a result the parent was already reviewing.
 */

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const callTool = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
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
  results: WorkspaceResultsService;
}

async function harness(t: test.TestContext): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-results-'));
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  const manager = new WorkspaceManager({ store });
  const results = new WorkspaceResultsService({ store });
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
  return { root, store, sessionId: session.id, manager, results };
}

function agentFor(h: Harness, provider: Provider): Agent {
  return new Agent({
    store: h.store,
    provider,
    tools: createTools(h.root),
    approve: async () => true,
    subagents: { enabled: true },
    workspaceMode: 'auto',
    workspaceManager: h.manager,
    workspaceResults: h.results,
    childTools: (binding) => createTools(binding?.executionRoot ?? h.root),
    workspaceRoots: (sessionId) => {
      const binding = h.manager.resolve(sessionId);
      return { projectRoot: binding.projectRoot, executionRoot: binding.executionRoot };
    },
  });
}

test('a child’s real changes are exported, including the ones a command made', async (t) => {
  const h = await harness(t);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'Change things', role: 'general' }]);
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      if (toolMessages.length === 0)
        // A *command*, deliberately: a result that read the file-tool journal instead of the directory would miss
        // this entirely, and it is exactly the case the plan calls out.
        return callTool('c-1', 'run_command', {
          command:
            "node -e \"require('fs').writeFileSync('from-command.txt', 'written by a command\\n')\"",
        });
      if (toolMessages.length === 1) return callTool('r-1', 'read_file', { path: 'same.txt' });
      if (toolMessages.length === 2)
        return callTool('e-1', 'edit_file', {
          path: 'same.txt',
          old_text: 'base\n',
          new_text: 'edited by the child\n',
        });
      return report('changed two things');
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() =>
    agent.run({ sessionId: h.sessionId, prompt: 'Change things' }),
  );
  assert.equal(result.status, 'completed', result.error);

  const child = h.store.childSessions(h.sessionId)[0]!;
  const exported = h.store.childWorkspaceResults(child.id);
  assert.equal(exported.length, 1);
  const record = exported[0]!;
  assert.equal(record.status, 'ready');
  assert.deepEqual([...record.paths].sort(), ['from-command.txt', 'same.txt']);
  const manifest = await h.results.manifest(record.id);
  assert.ok(manifest);
  assert.deepEqual(manifest.files.map((file) => [file.path, file.kind]).sort(), [
    ['from-command.txt', 'create'],
    ['same.txt', 'edit'],
  ]);
  // The frozen bytes are in the repository, not only in the manifest: the "before" of an edit is the baseline's
  // content and the "after" is the child's, and both are addressable objects.
  assert.notEqual(manifest.files.find((file) => file.path === 'same.txt')!.beforeBlob, null);
  assert.notEqual(manifest.files.find((file) => file.path === 'same.txt')!.afterBlob, null);
  // Evidence is what the child's *tools* recorded, so a model that claims success cannot manufacture it.
  assert.ok(manifest.evidence.some((entry) => entry.tool === 'run_command'));

  // The parent's own directory is untouched, and so is its journal: an isolated child's paths are relative to a
  // directory the parent's undo has never seen, so its changes belong to *its* journal until the parent imports
  // them. A parent journal that held them would make the parent's undo write into a tree it does not have.
  assert.equal(await readFile(path.join(h.root, 'same.txt'), 'utf8'), 'base\n');
  assert.equal(
    await readFile(path.join(h.root, 'from-command.txt'), 'utf8').catch(() => 'absent'),
    'absent',
  );
  assert.deepEqual(h.store.fileChanges(h.sessionId), []);
  assert.deepEqual(
    h.store.childSessions(h.sessionId).map((entry) => entry.id),
    [child.id],
  );
  assert.deepEqual(
    h.store.fileChanges(child.id).map((entry) => entry.change.path),
    ['same.txt'],
  );
});

test('binary, oversized and protected results are kept but marked unsupported', async (t) => {
  const h = await harness(t);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'Write a binary', role: 'general' }]);
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      if (toolMessages.length === 0)
        return callTool('b-1', 'run_command', {
          // A one-byte NUL is enough: this feature moves UTF-8 text and says so rather than guessing an encoding.
          command: "node -e \"require('fs').writeFileSync('blob.bin', Buffer.from([0,1,2,3]))\"",
        });
      return report('wrote a binary');
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() =>
    agent.run({ sessionId: h.sessionId, prompt: 'Write a binary' }),
  );
  assert.equal(result.status, 'completed', result.error);
  const child = h.store.childSessions(h.sessionId)[0]!;
  const record = h.store.childWorkspaceResults(child.id)[0]!;
  assert.equal(record.status, 'unsupported');
  // The record still names the path, so a person can find the work; what it does not do is claim it is importable.
  assert.deepEqual(record.paths, []);
  const manifest = await h.results.manifest(record.id);
  assert.equal(manifest!.files.length, 0);
  // And the file is still there, in the child's directory: unsupported means "look at it yourself", not "discard".
  const binding = h.store.workspaceBinding(child.id);
  assert.equal((await readFile(path.join(binding.executionRoot, 'blob.bin'))).length, 4);
  assert.equal(isUtf8Text(Buffer.from('plain text')), true);
  assert.equal(isUtf8Text(Buffer.from([0, 1, 2])), false);
});

test('a follow-up turn supersedes the previous result rather than replacing it', async (t) => {
  const h = await harness(t);
  let childTurn = 0;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'First', role: 'general' }]);
      }
      childTurn++;
      if (childTurn === 1)
        return callTool('w-1', 'write_file', { path: 'first.txt', content: 'one\n' });
      return report('first turn done');
    },
  };
  const agent = agentFor(h, provider);
  const first = await inHostMode(() => agent.run({ sessionId: h.sessionId, prompt: 'First' }));
  assert.equal(first.status, 'completed', first.error);
  const child = h.store.childSessions(h.sessionId)[0]!;
  const before = h.store.childWorkspaceResults(child.id)[0]!;
  assert.equal(before.status, 'ready');

  // A follow-up turn: the child changes its directory again, and a second export is taken.
  const binding = h.store.workspaceBinding(child.id);
  await writeFile(path.join(binding.executionRoot, 'second.txt'), 'two\n');
  const second = await h.results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  // Two results, one current: the earlier one is marked superseded rather than deleted, because the answer to
  // "what did this child produce first" has to survive being replaced.
  assert.equal(h.store.childWorkspaceResults(child.id).length, 2);
  assert.equal(h.store.workspaceResult(before.id)!.status, 'superseded');
  assert.equal(second.status, 'ready');
  assert.deepEqual(second.paths, ['first.txt', 'second.txt']);
});

test('an export refuses a shared workspace and a running child, and reports it', async (t) => {
  const h = await harness(t);
  const sharedChild = h.store.create(h.root, h.sessionId);
  await assert.rejects(
    h.results.export({ childSessionId: sharedChild.id, signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_UNSUPPORTED_RESULT');
      return true;
    },
  );

  // A child whose turn is still live has a directory that is still moving, so there is nothing stable to freeze.
  const binding = h.store.createWorkspaceBinding({
    parentSessionId: h.sessionId,
    projectRoot: h.root,
    executionRoot: h.root,
    repositoryRoot: h.root,
    kind: 'worktree',
    snapshotId: 'missing-snapshot',
    baseCommit: 'a'.repeat(40),
  });
  const running = h.store.create(h.root, h.sessionId);
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: running.id });
  h.store.beginRun(running.id);
  await assert.rejects(
    h.results.export({ childSessionId: running.id, signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_BUSY');
      return true;
    },
  );
});

test('every result is referenced, so a later gc cannot collect it', async (t) => {
  const h = await harness(t);
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await h.manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: h.manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await h.manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'kept.txt'), 'kept\n');
  const result = await h.results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  // The tree is named by a ref of its own, which is what makes the frozen bytes survive repository maintenance —
  // an unreferenced object is garbage to `git gc`, and a result that could be collected would be a review that
  // silently stops being applicable.
  const ref = git(h.root, ['rev-parse', `refs/yuantu/results/${result.id}`]);
  assert.equal(ref, result.resultTree);
  // The comparison tree of a first result is the frozen baseline, which is what makes it a diff of the child's work
  // rather than of everything the parent has ever done.
  assert.equal(result.comparisonTree, snapshot.baseTree);
});

test('a later export compares against what the parent accepted, not the baseline', async (t) => {
  const h = await harness(t);
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await h.manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: h.manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await h.manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'first.txt'), 'one\n');
  const first = await h.results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  // Standing in for an import the parent accepted: the comparison tree moves only here, and the assertion below is
  // that the *next* export measures from it rather than offering the same change again.
  h.store.setWorkspaceResultStatus({ resultId: first.id, expect: 'ready', to: 'applied' });
  await writeFile(path.join(binding.executionRoot, 'second.txt'), 'two\n');
  const second = await h.results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  assert.equal(second.comparisonTree, first.resultTree);
  assert.deepEqual(second.paths, ['second.txt']);
});

test('a result carries the child’s tool evidence and nothing the model claimed', async (t) => {
  const h = await harness(t);
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
        return delegate([{ objective: 'Run a check', role: 'general' }]);
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      if (toolMessages.length === 0)
        return callTool('v-1', 'run_command', { command: 'node -e "process.exit(0)"' });
      // The child *claims* a passing test in prose. The manifest's evidence comes from the tool records, so the
      // claim adds nothing and cannot add anything.
      return report('all tests pass, verified');
    },
  };
  const agent = agentFor(h, provider);
  const result = await inHostMode(() =>
    agent.run({ sessionId: h.sessionId, prompt: 'Run a check' }),
  );
  assert.equal(result.status, 'completed', result.error);
  const child = h.store.childSessions(h.sessionId)[0]!;
  const record = h.store.childWorkspaceResults(child.id)[0]!;
  const manifest = await h.results.manifest(record.id);
  assert.ok(manifest!.evidence.length >= 1);
  for (const entry of manifest!.evidence) assert.equal(typeof entry.tool, 'string');
  // A directory with no changes still produces a result: "the child changed nothing" is an answer the parent needs,
  // and an absent result would be indistinguishable from an export that never ran.
  assert.deepEqual(record.paths, []);
  assert.equal(record.status, 'ready');
});

test('an unsupported path is named so a person can find it, and the good paths still travel', async (t) => {
  const h = await harness(t);
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await h.manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: h.manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await h.manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  const diagnostics: string[] = [];
  const results = new WorkspaceResultsService({
    store: h.store,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  // One importable change and one that is not: this version refuses the whole result rather than importing part of
  // it, because half a change is the outcome a parent cannot tell apart from a complete one.
  await writeFile(path.join(binding.executionRoot, 'plain.txt'), 'text\n');
  await writeFile(path.join(binding.executionRoot, 'binary.bin'), Buffer.from([0, 1, 2]));
  const result = await results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.paths, [], 'nothing is offered for import when any path cannot travel');
  assert.match(diagnostics.join('\n'), /binary\.bin/);
  // Both files are still in the child's directory: the refusal is about moving them, not about keeping them.
  assert.equal(await readFile(path.join(binding.executionRoot, 'plain.txt'), 'utf8'), 'text\n');
  assert.equal((await readFile(path.join(binding.executionRoot, 'binary.bin'))).length, 3);
});
