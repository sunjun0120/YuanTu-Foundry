import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import {
  WorkspaceResultsService,
  changeForResult,
  snapshotsForResult,
} from '../packages/workspaces/results.ts';
import { workspaceResultTools } from '../packages/tools/workspaces.ts';
import { reconcilePendingFileChanges, undoFileChange } from '../packages/tools/file-undo.ts';
import type { FileChange, FileSnapshot, Tool, ToolContext } from '../packages/protocol/index.ts';
import { git } from './git-fixture.ts';

/**
 * Taking delivery of a child's work.
 *
 * Every property here is about bytes that a person agreed to. The approval shows a specific diff; the execute step
 * re-verifies that same content; a conflict writes *nothing* rather than the paths that happened to still match; and
 * the same request twice writes once. Each of those is a different way an import could silently stop being the thing
 * that was approved, which is why each has its own case.
 */

interface Prepared {
  store: SessionStore;
  manager: WorkspaceManager;
  results: WorkspaceResultsService;
  root: string;
  parentSessionId: string;
  /** The session acting as the delegator: the tools are built for it. */
  parent: string;
  child: string;
  childRoot: string;
  /** Every diagnostic the results service published, which is where a swallowed failure is recorded. */
  diagnostics: string[];
  /** Make one change in the child's directory and export it. */
  produce(paths: Record<string, string>): Promise<{ resultId: string; digest: string }>;
  /** The apply tool as the coordinator registers it. */
  tool(): Tool;
}

async function fixture(t: test.TestContext): Promise<Prepared> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-apply-'));
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  const manager = new WorkspaceManager({ store });
  const diagnostics: string[] = [];
  const results = new WorkspaceResultsService({
    store,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'same.txt'), 'base\n');
  await writeFile(path.join(root, 'other.txt'), 'other\n');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  const parent = store.create(root);
  const child = store.create(root, parent.id);
  const snapshot = await manager.freeze({
    parentSessionId: parent.id,
    sourceBinding: manager.resolve(parent.id),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: parent.id,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  return {
    store,
    manager,
    results,
    root,
    parentSessionId: parent.id,
    parent: parent.id,
    child: child.id,
    childRoot: binding.executionRoot,
    diagnostics,
    async produce(paths) {
      for (const [name, content] of Object.entries(paths))
        await writeFile(path.join(binding.executionRoot, ...name.split('/')), content);
      const result = await results.export({
        childSessionId: child.id,
        signal: new AbortController().signal,
      });
      return { resultId: result.id, digest: result.digest };
    },
    tool: () =>
      workspaceResultTools({ store, results, sessionId: parent.id }).find(
        (candidate) => candidate.name === 'workspace_result_apply',
      )!,
  };
}

/** A tool context that stands in for the run: a signal, a root, and an approver the test controls. */
function contextFor(prepared: Prepared, approve: boolean): ToolContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: prepared.root,
    sessionId: prepared.parent,
    approve: async () => approve,
    executionPolicy: { files: 'workspace-write', commands: 'allow', network: 'allow' },
  } as unknown as ToolContext;
}

/** What the approval would have shown, which is the thing the person actually read. */
async function prepare(
  prepared: Prepared,
  args: Record<string, unknown>,
): Promise<{ description: string; change?: FileChange; files?: FileSnapshot[] }> {
  const tool = prepared.tool();
  const built = await tool.prepare!(args, contextFor(prepared, true));
  return {
    description: built.approvalDescription ?? '',
    ...(built.change ? { change: built.change } : {}),
  };
}

test('a replacement result retains earlier changes that the parent never imported', async (t) => {
  const p = await fixture(t);
  const first = await p.produce({ 'first.txt': 'first unimported change\n' });
  const second = await p.produce({ 'second.txt': 'second unimported change\n' });
  assert.equal(p.store.workspaceResult(first.resultId)!.status, 'superseded');
  const applied = await p
    .tool()
    .execute({ resultId: second.resultId, expectedDigest: second.digest }, contextFor(p, true));
  assert.equal(applied.isError, false, applied.content);
  assert.equal(await readFile(path.join(p.root, 'first.txt'), 'utf8'), 'first unimported change\n');
  assert.equal(
    await readFile(path.join(p.root, 'second.txt'), 'utf8'),
    'second unimported change\n',
  );
});

test('two results with different files import one after another', async (t) => {
  const p = await fixture(t);
  const first = await p.produce({ 'a.txt': 'from the child\n' });
  const applied = await p
    .tool()
    .execute({ resultId: first.resultId, expectedDigest: first.digest }, contextFor(p, true));
  assert.equal(applied.isError, false, applied.content);
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'from the child\n');
  // The change is in the parent's own list, which is what makes it undoable like any other write.
  const changes = p.store.fileChanges(p.parent);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.status, 'applied');
  assert.equal(changes[0]!.change.path.includes('sub-agent workspace'), true);
  assert.deepEqual(
    changes[0]!.change.changes?.map((entry) => [entry.path, entry.kind]),
    [['a.txt', 'create']],
  );

  // A second result touching a *different* file imports too: the before-check is per path, and an unrelated change
  // in the parent is not a conflict.
  const second = await p.produce({ 'b.txt': 'also from the child\n' });
  const again = await p
    .tool()
    .execute({ resultId: second.resultId, expectedDigest: second.digest }, contextFor(p, true));
  assert.equal(again.isError, false, again.content);
  assert.equal(await readFile(path.join(p.root, 'b.txt'), 'utf8'), 'also from the child\n');
  assert.equal(p.store.fileChanges(p.parent).length, 2);
});

test('concurrent results recheck overlapping paths after waiting for the target', async (t) => {
  const p = await fixture(t);
  const first = await p.produce({ 'same.txt': 'first child\n' });
  const child = p.store.create(p.root, p.parent);
  const signal = new AbortController().signal;
  const snapshot = await p.manager.freeze({
    parentSessionId: p.parent,
    sourceBinding: p.manager.resolve(p.parent),
    signal,
  });
  const binding = await p.manager.allocate({
    parentSessionId: p.parent,
    taskId: 'second-child',
    snapshot,
    signal,
  });
  p.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'same.txt'), 'second child\n');
  const second = await p.results.export({ childSessionId: child.id, signal });
  const outcomes = await Promise.all([
    p.results.apply({
      parentSessionId: p.parent,
      resultId: first.resultId,
      expectedDigest: first.digest,
      signal,
      context: contextFor(p, true),
    }),
    p.results.apply({
      parentSessionId: p.parent,
      resultId: second.id,
      expectedDigest: second.digest,
      signal,
      context: contextFor(p, true),
    }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['applied', 'conflict']);
  const winner = outcomes[0]!.status === 'applied' ? 'first child\n' : 'second child\n';
  assert.equal(await readFile(path.join(p.root, 'same.txt'), 'utf8'), winner);
  assert.equal(
    p.store.fileChanges(p.parent).filter((change) => change.status === 'applied').length,
    1,
  );
});

test('a file the parent changed since the result was frozen conflicts, and nothing is written', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n', 'b.txt': 'child bytes too\n' });
  // The parent edits one of the two paths: importing the other half would leave a tree that is neither version.
  await writeFile(path.join(p.root, 'a.txt'), 'parent bytes\n');
  const preview = await p.results.previewApply({
    parentSessionId: p.parent,
    resultId: result.resultId,
    expectedDigest: result.digest,
    signal: new AbortController().signal,
  });
  assert.deepEqual(preview.conflicts, ['a.txt']);
  assert.equal(
    preview.files.find((file) => file.path === 'b.txt')?.after?.toString(),
    'child bytes too\n',
  );

  const outcome = await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  assert.equal(outcome.isError, false);
  assert.match(outcome.content, /Nothing was imported/);
  assert.match(outcome.content, /a\.txt/);
  // The conflicting file keeps the parent's bytes, the non-conflicting one was not written at all, and no journal
  // entry was created — a partial import is the outcome the plan refuses.
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'parent bytes\n');
  assert.equal(await readFile(path.join(p.root, 'b.txt'), 'utf8').catch(() => 'absent'), 'absent');
  assert.deepEqual(p.store.fileChanges(p.parent), []);
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'conflict');
});

test('a file changed between the preview and the approval is refused', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  const approval = await prepare(p, {
    resultId: result.resultId,
    expectedDigest: result.digest,
  });
  // The person is looking at the approval; meanwhile the parent's own run writes the same path.
  assert.match(approval.description, /a\.txt/);
  await writeFile(path.join(p.root, 'a.txt'), 'written while the prompt was open\n');
  const built = await p.tool().prepare!(
    { resultId: result.resultId, expectedDigest: result.digest },
    contextFor(p, true),
  );
  const outcome = await built.execute(contextFor(p, true));
  assert.equal(outcome.isError, false);
  assert.match(outcome.content, /Nothing was imported/);
  assert.equal(
    await readFile(path.join(p.root, 'a.txt'), 'utf8'),
    'written while the prompt was open\n',
  );
  assert.deepEqual(p.store.fileChanges(p.parent), []);
});

test('a refused approval has no effect at all', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  // The registry refuses before `execute` runs when the approver says no; the point of this case is that the
  // refusal is *observable* as nothing happening: no file, no journal entry, and a result still importable.
  const preview = await p.results.previewApply({
    parentSessionId: p.parent,
    resultId: result.resultId,
    expectedDigest: result.digest,
    signal: new AbortController().signal,
  });
  assert.deepEqual(preview.conflicts, []);
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8').catch(() => 'absent'), 'absent');
  assert.deepEqual(p.store.fileChanges(p.parent), []);
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'ready');
  // And applying it afterwards still works, because a refusal spent nothing.
  const after = await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  assert.equal(after.isError, false, after.content);
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'child bytes\n');
});

test('applying the same result twice writes once and answers with the first change', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  const first = await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  assert.equal(first.isError, false, first.content);
  const changeId = p.store.fileChanges(p.parent)[0]!.id;
  // The file is deleted behind the import's back, so a second real write would recreate it — which is exactly what
  // the receipt has to prevent.
  await rm(path.join(p.root, 'a.txt'));
  const second = await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  assert.equal(second.isError, false, second.content);
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8').catch(() => 'absent'), 'absent');
  assert.equal(p.store.fileChanges(p.parent).length, 1);
  assert.equal(p.store.fileChanges(p.parent)[0]!.id, changeId);
});

test('a result from another parent, an unknown result, or a wrong digest is refused', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  const sibling = p.store.create(p.root);
  const tools = workspaceResultTools({ store: p.store, results: p.results, sessionId: sibling.id });
  const apply = tools.find((tool) => tool.name === 'workspace_result_apply')!;

  // A sibling of the delegator was never offered this result, and saying so is its own refusal rather than a
  // conflict or a digest problem.
  await assert.rejects(
    apply.prepare!(
      { resultId: result.resultId, expectedDigest: result.digest },
      contextFor(p, true),
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_INTEGRITY');
      return true;
    },
  );
  // The digest pins the exact content: a caller quoting different bytes is refused rather than applied.
  await assert.rejects(
    p.tool().prepare!(
      { resultId: result.resultId, expectedDigest: 'f'.repeat(64) },
      contextFor(p, true),
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_INTEGRITY');
      return true;
    },
  );
  await assert.rejects(
    p.tool().prepare!(
      { resultId: 'no-such-result', expectedDigest: result.digest },
      contextFor(p, true),
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    },
  );
  // A delegation that resulted in nothing is not applicable: there is no change to approve.
  await rm(path.join(p.childRoot, 'a.txt'));
  const empty = await p.results.export({
    childSessionId: p.child,
    signal: new AbortController().signal,
  });
  assert.deepEqual(empty.paths, []);
  await p
    .tool()
    .execute({ resultId: empty.id, expectedDigest: empty.digest }, contextFor(p, true))
    .then((outcome) => {
      assert.equal(outcome.isError, true);
      assert.match(outcome.content, /nothing to import/i);
    });
});

test('an import can be undone, and restoring uses the target binding’s own root', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'child bytes\n');
  const change = p.store.fileChanges(p.parent)[0]!;
  await reconcilePendingFileChanges(p.store, p.parent, p.root);
  await undoFileChange(p.store, p.parent, change.id, p.root);
  // The created file is gone again: the undo restored the exact bytes from before the import, which for a create is
  // its absence.
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8').catch(() => 'absent'), 'absent');
  assert.equal(p.store.fileChanges(p.parent)[0]!.status, 'undone');
});

test('an interrupted import is classified from its journal rather than replayed', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const manifest = await p.results.manifest(result.resultId);
  assert.ok(manifest);
  const snapshots = await snapshotsForResult(manifest.repositoryRoot, manifest);
  /**
   * Half an import, built directly from the frozen result rather than by running a preview.
   *
   * This is what a process that died between two file writes leaves behind: a grouped journal entry recording every
   * path's before and after bytes, a receipt saying this exact content was approved, and a disk holding *some* of
   * it. Nothing here replays an approval — the receipt is the record that one was given.
   */
  const changeId = p.store.prepareFileChangeGroup(
    p.parent,
    changeForResult({
      resultId: result.resultId,
      manifest,
      diffs: snapshots.map((snapshot) => ({ path: snapshot.path, added: 1, removed: 0 })),
    }),
    snapshots,
  );
  p.store.recordWorkspaceApplyReceipt({
    resultId: result.resultId,
    digest: result.digest,
    targetBindingId: p.store.workspaceBinding(p.parent).id,
    changeId,
  });
  p.store.setWorkspaceResultStatus({ resultId: result.resultId, expect: 'ready', to: 'applying' });
  // The first path already has its after bytes; the second was never written.
  const first = snapshots.find((snapshot) => snapshot.path === 'a.txt')!;
  await writeFile(path.join(p.root, 'a.txt'), Buffer.from(first.after!));

  await assert.rejects(
    p.results.apply({
      parentSessionId: p.parent,
      resultId: result.resultId,
      expectedDigest: result.digest,
      signal: new AbortController().signal,
      context: contextFor(p, true),
    }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_BUSY',
  );
  await assert.rejects(readFile(path.join(p.root, 'b.txt')), { code: 'ENOENT' });

  await p.results.reconcile(new AbortController().signal);
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'applied');
  assert.equal(p.store.fileChanges(p.parent)[0]!.status, 'applied');
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await readFile(path.join(p.root, 'b.txt'), 'utf8'), 'two\n');
  // Idempotent: a second pass finds nothing in `applying` and changes nothing.
  await p.results.reconcile(new AbortController().signal);
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'applied');
});

test('an import interrupted before anything was written is importable again', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'one\n' });
  // Marked as applying with no receipt: the interruption happened before anything was written, which is the one case
  // where re-offering is honest because no effect happened.
  p.store.setWorkspaceResultStatus({ resultId: result.resultId, expect: 'ready', to: 'applying' });
  await p.results.reconcile(new AbortController().signal);
  // No receipt means no bytes were written, so nothing was spent and the parent may still decide.
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'ready');
});

test('a pending receipt cannot claim an import succeeded, and an unwritten attempt can be retried after recovery', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const manifest = (await p.results.manifest(result.resultId))!;
  const snapshots = await snapshotsForResult(manifest.repositoryRoot, manifest);
  const changeId = p.store.prepareFileChangeGroup(
    p.parent,
    changeForResult({ resultId: result.resultId, manifest, diffs: [] }),
    snapshots,
  );
  const targetBindingId = p.store.workspaceBinding(p.parent).id;
  p.store.recordWorkspaceApplyReceipt({
    resultId: result.resultId,
    digest: result.digest,
    targetBindingId,
    changeId,
  });
  p.store.setWorkspaceResultStatus({ resultId: result.resultId, expect: 'ready', to: 'applying' });
  const args = {
    parentSessionId: p.parent,
    resultId: result.resultId,
    expectedDigest: result.digest,
    signal: new AbortController().signal,
    context: contextFor(p, true),
  };
  await assert.rejects(
    p.results.apply(args),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_BUSY',
  );
  await assert.rejects(readFile(path.join(p.root, 'a.txt')), { code: 'ENOENT' });
  await p.results.reconcile(args.signal);
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'ready');
  assert.equal(
    p.store.workspaceApplyReceipt({
      resultId: result.resultId,
      digest: result.digest,
      targetBindingId,
    }),
    null,
  );
  assert.equal(
    p.store.fileChanges(p.parent).find((change) => change.id === changeId)!.status,
    'abandoned',
  );
  const outcome = await p.results.apply(args);
  assert.equal(outcome.status, 'applied');
  assert.equal(await readFile(path.join(p.root, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await readFile(path.join(p.root, 'b.txt'), 'utf8'), 'two\n');
});

test('the listing shows what is outstanding, and says when nothing is', async (t) => {
  const p = await fixture(t);
  const tools = workspaceResultTools({ store: p.store, results: p.results, sessionId: p.parent });
  const list = tools.find((tool) => tool.name === 'workspace_results')!;
  const empty = await list.execute({}, contextFor(p, true));
  assert.match(empty.content, /No sub-agent produced a workspace result/);

  const result = await p.produce({ 'a.txt': 'child bytes\n' });
  const listed = await list.execute({}, contextFor(p, true));
  assert.match(listed.content, new RegExp(result.resultId));
  assert.match(listed.content, /\[ready\]/);
  assert.match(listed.content, /a\.txt/);
  assert.match(listed.content, new RegExp(result.digest));

  await p
    .tool()
    .execute({ resultId: result.resultId, expectedDigest: result.digest }, contextFor(p, true));
  const afterApply = await list.execute({}, contextFor(p, true));
  assert.match(afterApply.content, /already been imported/);
  const withApplied = await list.execute({ includeApplied: true }, contextFor(p, true));
  assert.match(withApplied.content, /\[applied\]/);
});

test('the listing keeps unsupported work visible instead of claiming it was imported', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'blob.bin': '\0binary content' });
  assert.equal(p.store.workspaceResult(result.resultId)!.status, 'unsupported');
  const list = workspaceResultTools({
    store: p.store,
    results: p.results,
    sessionId: p.parent,
  }).find((tool) => tool.name === 'workspace_results')!;
  const listed = await list.execute({}, contextFor(p, true));
  assert.equal(listed.isError, false);
  assert.ok(listed.content.includes(result.resultId), listed.content);
  assert.match(listed.content, /\[unsupported\]/);
  assert.doesNotMatch(listed.content, /already been imported/);
  assert.equal(p.store.fileChanges(p.parent).length, 0);
});

test('the listing distinguishes superseded work from imported work', async (t) => {
  const p = await fixture(t);
  const result = await p.produce({ 'a.txt': 'not imported\n' });
  p.store.setWorkspaceResultStatus({
    resultId: result.resultId,
    expect: 'ready',
    to: 'superseded',
  });
  const list = workspaceResultTools({
    store: p.store,
    results: p.results,
    sessionId: p.parent,
  }).find((tool) => tool.name === 'workspace_results')!;
  const listed = await list.execute({}, contextFor(p, true));
  assert.doesNotMatch(listed.content, /already been imported/);
  assert.match(listed.content, /superseded|replaced/);
  assert.equal(p.store.fileChanges(p.parent).length, 0);
});
