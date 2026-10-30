import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../packages/knowledge/store.ts';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { riskWorker } from './risk-concurrency.ts';
import { knowledgeTools } from '../packages/knowledge/tools.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { memoryContext } from '../packages/knowledge/context.ts';
import {
  memoryPaths,
  forgetMemoryEntry,
  listMemoryEntries,
  memoryLimits,
  memoryFile,
  memorySummary,
  memoryUsage,
  memoryUsageFile,
  recordMemoryUse,
  MEMORY_NOTES_FILE,
  MemoryConflictError,
  parseMemoryEntry,
  readMemoryDirectory,
  renderMemoryEntry,
  saveMemoryEntry,
  memorySources,
  maintainMemories,
  memoryArchiveDir,
  memoryScore,
  memoryScoring,
  readArchivedEntries,
  readMemoryEntry,
  recordMemoriesSeen,
  restoreMemoryEntry,
} from '../packages/knowledge/memory.ts';
import { Agent } from '../packages/core/agent.ts';
import { AGENT_SYSTEM_PROMPT, agentSystemPrompt } from '../packages/core/prompt/notices.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { Message, ModelRequest } from '../packages/protocol/index.ts';
import { tempRoot } from './temp-fixture.ts';

test('concurrent pins competing for the last document slot preserve the quota and whole indexes', async (t) => {
  const root = await tempRoot(t, 'yuantu-knowledge-quota-race-');
  const file = path.join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore(file);
  try {
    for (let i = 0; i < 65; i++) {
      await writeFile(path.join(root, `doc-${i}.md`), `document marker${i}`);
      if (i < 63) store.pinDocument(root, `doc-${i}.md`);
    }
  } finally {
    store.close();
  }
  const first = riskWorker('knowledge', file, root, 'doc-63.md', path.join(root, 'first'));
  let second: ReturnType<typeof riskWorker> | undefined;
  try {
    await first.ready();
    second = riskWorker('knowledge', file, root, 'doc-64.md', path.join(root, 'second'));
    await second.ready();
    await first.release();
    assert.deepEqual(await first.result, { ok: true });
    await second.release();
    const rejected = await second.result;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /64/);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_documents').get()?.n, 64);
      assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_items').get()?.n, 64);
      assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_fts').get()?.n, 64);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM knowledge_documents WHERE path=?').get('doc-64.md')
          ?.n,
        0,
      );
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  } finally {
    await Promise.all([first.stop(), second?.stop()]);
  }
});

test('a file rewrite between reading and committing is refreshed as a complete snapshot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-knowledge-refresh-race-'));
  const file = path.join(root, 'knowledge.sqlite');
  const document = path.join(root, 'selected.md');
  await writeFile(document, 'oldsnapshot');
  const store = new KnowledgeStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const exec = DatabaseSync.prototype.exec;
  let rewritten = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE' && !rewritten) {
      rewritten = true;
      writeFileSync(document, 'newsnapshot');
    }
    return exec.call(this, sql);
  });
  store.pinDocument(root, 'selected.md');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT content FROM knowledge_items').get()?.content, 'oldsnapshot');
    assert.equal(store.search(root, 'newsnapshot')[0]?.content, 'newsnapshot');
    assert.deepEqual(store.search(root, 'oldsnapshot'), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_fts').get()?.n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

// ---- merged from knowledge.test.ts ----

test('pinned project documents are searchable, refreshed and removable without indexing unselected files', async (t) => {
  const root = await tempRoot(t, 'yuantu-doc-index-');
  const db = path.join(root, 'knowledge.sqlite');
  await writeFile(path.join(root, 'selected.md'), '部署：运行 npm run deploy。');
  await writeFile(path.join(root, 'unselected.md'), 'private-unselected-marker');
  const store = new KnowledgeStore(db);
  assert.deepEqual(store.search(root, '部署'), []);
  store.pinDocument(root, 'selected.md');
  assert.equal(store.search(root, '部署')[0]?.source, 'selected.md');
  assert.deepEqual(store.search(root, 'private-unselected-marker'), []);
  await writeFile(path.join(root, 'selected.md'), '现在使用 pnpm build 构建。');
  assert.equal(store.search(root, 'pnpm build')[0]?.source, 'selected.md');
  assert.deepEqual(store.search(root, 'npm run deploy'), []);
  assert.equal(store.listDocuments(root).length, 1);
  store.unpinDocument(root, 'selected.md');
  assert.deepEqual(store.search(root, 'pnpm build'), []);
  store.close();
});

/**
 * Regression: search() took an unordered `LIMIT 120` window and scored title (+4) / content (+2) in
 * JS, breaking ties by `updated_at`. So the window's contents were decided by the query plan — rows
 * come back in `document_id` hash order, making which documents survived arbitrary — and FTS5
 * relevance was never consulted. Relevance now decides in SQL, with recency demoted to a tie-break,
 * and only the best chunk per document is returned.
 */
test('search ranks by relevance instead of insertion recency and dedupes chunks', async (t) => {
  const root = await tempRoot(t, 'yuantu-doc-rank-');
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  // A short, dense match pinned FIRST, so it is the oldest row.
  await writeFile(path.join(root, 'dense.md'), `Dense\n${'alpha '.repeat(40)}end`);
  store.pinDocument(root, 'dense.md');
  // Unrelated documents keep the term's inverse document frequency positive.
  for (let i = 1; i <= 6; i++) {
    await writeFile(path.join(root, `other-${i}.md`), `Other ${i}\n${'beta gamma '.repeat(60)}`);
    store.pinDocument(root, `other-${i}.md`);
  }
  // A long, sparse match pinned LAST, so it is the newest row. The old code picked it purely because
  // both documents scored 2 and `updatedAt` broke the tie.
  await writeFile(path.join(root, 'sparse.md'), `Sparse\n${'beta '.repeat(280)}alpha`);
  store.pinDocument(root, 'sparse.md');

  const results = store.search(root, 'alpha', 2);
  assert.equal(
    results[0]?.source,
    'dense.md',
    'the denser match must outrank the newer but sparser one',
  );
  assert.deepEqual(
    results.map((entry) => entry.source),
    ['dense.md', 'sparse.md'],
    'a multi-chunk document must not occupy several result slots',
  );
  // Recency is still honoured as a tie-break, so equally relevant hits stay newest-first.
  const ordered = store.search(root, 'beta', 2);
  assert.equal(new Set(ordered.map((entry) => entry.source)).size, ordered.length);
  store.close();
});

test('indexing refuses paths outside workspace, links, credentials and oversized files', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-');
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  await writeFile(path.join(root, '.env'), 'KEY=secret');
  await writeFile(path.join(root, 'huge.md'), 'x'.repeat(33000));
  assert.throws(() => store.pinDocument(root, '../outside.md'));
  assert.throws(() => store.pinDocument(root, '.env'));
  assert.throws(() => store.pinDocument(root, 'huge.md'));
  assert.deepEqual(store.listDocuments(root), []);
  store.close();
});

/**
 * Regression: refreshDocuments() used to unpin a document on ANY re-read failure, so a transient
 * or recoverable condition permanently deleted the index entry with no error surfaced. Only a
 * genuinely absent source file may drop the entry now.
 */
test('a refresh failure keeps the index entry; only a removed file unpins it', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-refresh-');
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const doc = path.join(root, 'guide.md');
  await writeFile(doc, '部署使用 npm run deploy。');
  store.pinDocument(root, 'guide.md');
  assert.equal(store.search(root, '部署')[0]?.source, 'guide.md');

  // The file still exists but can no longer be read by the pin path (it grew past the 32KB
  // resource limit). That used to be treated as "gone" and silently deleted the document.
  await writeFile(doc, '部署使用 npm run deploy。' + 'x'.repeat(33000));
  assert.equal(
    store.search(root, '部署')[0]?.source,
    'guide.md',
    'a recoverable read failure must not delete the index entry',
  );
  assert.equal(store.listDocuments(root).length, 1);
  const stale = store.freshness(root);
  assert.equal(
    stale.stale,
    true,
    'the failed refresh is reported, not hidden behind the old content',
  );
  assert.equal(stale.documents[0]?.path, 'guide.md');
  assert.match(stale.documents[0]?.error ?? '', /32KB/);
  assert.ok(
    stale.documents[0]?.lastIndexedAt,
    'the stale document names when its content was indexed',
  );

  // Shrinking it again makes the next refresh pick the new content up.
  await writeFile(doc, '现在使用 pnpm build 构建。');
  assert.equal(store.search(root, 'pnpm build')[0]?.source, 'guide.md');
  assert.equal(store.freshness(root).stale, false, 'a successful re-read clears the failure');

  // A genuinely removed source file is the one case that drops the entry.
  await rm(doc);
  assert.deepEqual(store.search(root, 'pnpm build'), []);
  assert.deepEqual(store.listDocuments(root), []);
  assert.deepEqual(store.freshness(root).documents, [], 'a removed document is gone, not stale');
  store.close();
});

/** Memories must never reach the real home directory from a test. */
async function memoryFixture(t: test.TestContext, prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const globalDir = await mkdtemp(path.join(tmpdir(), prefix + 'global-'));
  const db = path.join(root, 'knowledge.sqlite');
  const previous = {
    memory: process.env.YUANTU_MEMORY_DIR,
    knowledge: process.env.YUANTU_KNOWLEDGE_DB,
  };
  process.env.YUANTU_MEMORY_DIR = globalDir;
  process.env.YUANTU_KNOWLEDGE_DB = db;
  t.after(async () => {
    if (previous.memory === undefined) delete process.env.YUANTU_MEMORY_DIR;
    else process.env.YUANTU_MEMORY_DIR = previous.memory;
    if (previous.knowledge === undefined) delete process.env.YUANTU_KNOWLEDGE_DB;
    else process.env.YUANTU_KNOWLEDGE_DB = previous.knowledge;
    await rm(root, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });
  return { root, globalDir, db, ...memoryPaths(root, globalDir) };
}

test('Agent can recall saved knowledge but persistent writes still require approval', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-tool-');
  const { saveMemoryEntry } = await import('../packages/knowledge/memory.ts');
  await saveMemoryEntry(workspace, 'release', 'Use staged rollout 481');
  const source = knowledgeTools(root),
    registry = new ToolRegistry();
  source.tools.forEach((tool) => registry.register(tool));
  registry.onClose(source.close);
  const signal = new AbortController().signal;
  const recall = await registry.execute(
    { id: 'read', name: 'recall_knowledge', arguments: { query: 'rollout 481' } },
    { signal, approve: async () => false },
  );
  assert.equal(recall.isError, false);
  assert.match(recall.content, /Use staged rollout 481/);
  assert.match(recall.content, /\.yuantu\/memory\/release\.md/, 'the result names its source file');
  const recalled = JSON.parse(recall.content);
  assert.ok(Array.isArray(recalled.results));
  assert.deepEqual(recalled.freshness, {
    stale: false,
    checkedAt: recalled.freshness.checkedAt,
    documents: [],
  });
  const save = {
    id: 'write',
    name: 'save_memory',
    arguments: {
      scope: 'workspace',
      key: 'no-auto-save',
      type: 'feedback',
      description: 'Must ask first',
      content: 'Must ask first',
    },
  };
  const denied = await registry.execute(save, { signal, approve: async () => false });
  assert.equal(denied.isError, true);
  const afterDenial = await registry.execute(
    { id: 'probe', name: 'list_memories', arguments: {} },
    { signal, approve: async () => false },
  );
  assert.doesNotMatch(afterDenial.content, /Must ask first/);
  const accepted = await registry.execute(save, { signal, approve: async () => true });
  assert.equal(accepted.isError, false);
  const listed = await registry.execute(
    { id: 'list', name: 'list_memories', arguments: {} },
    { signal, approve: async () => false },
  );
  assert.match(listed.content, /Must ask first/);
  await registry.close();
});

test('new Agent runs see a bounded reminder of saved cross-session memory', async (t) => {
  const { root, globalDir, workspace, global } = await memoryFixture(t, 'yuantu-memory-context-');
  assert.equal(await memoryContext(root, globalDir), '');
  const { saveMemoryEntry } = await import('../packages/knowledge/memory.ts');
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  await saveMemoryEntry(workspace, 'build', 'Use the local build 348');
  const prompt = await memoryContext(root, globalDir);
  assert.match(prompt, /Respond in Chinese/);
  assert.match(prompt, /local build 348/);
  assert.match(prompt, /recall_knowledge/);
  assert.match(prompt, /markdown files the user can also edit/);
});

test('Agent manages memories and indexed documents through approved tools', async (t) => {
  const { root } = await memoryFixture(t, 'yuantu-agent-memory-');
  await writeFile(path.join(root, 'guide.md'), 'Release process uses staging wave 947.');
  const source = knowledgeTools(root);
  const registry = new ToolRegistry();
  source.tools.forEach((tool) => registry.register(tool));
  registry.onClose(source.close);
  const signal = new AbortController().signal;
  const run = (id: string, name: string, args: Record<string, unknown>, allow: boolean) =>
    registry.execute(
      { id, name, arguments: args },
      { signal, approve: async () => allow, sessionId: 'session-7' },
    );

  const created = await run(
    '1',
    'save_memory',
    {
      scope: 'workspace',
      key: 'build-preference',
      type: 'feedback',
      description: 'Build with npm run build',
      content: 'Use npm run build',
    },
    true,
  );
  assert.equal(created.isError, false);
  assert.equal(JSON.parse(created.content).key, 'build-preference');
  const listed = await run('2', 'list_memories', {}, false);
  const [first] = JSON.parse(listed.content).memories.workspace;
  assert.equal(first.key, 'build-preference');
  assert.equal(first.type, 'feedback');
  assert.equal(first.session, 'session-7', 'the writing session is recorded');
  assert.equal(first.text, undefined, 'a listing names memories without their text');
  const read = await run(
    '2b',
    'read_memory',
    { scope: 'workspace', key: 'build-preference' },
    false,
  );
  assert.equal(read.isError, false, read.content);
  assert.equal(JSON.parse(read.content).text, 'Use npm run build');
  assert.equal(JSON.parse(read.content).revision, first.revision);
  const missing = await run('2c', 'read_memory', { scope: 'workspace', key: 'absent' }, false);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /No memory named absent/);
  const update = { scope: 'workspace', key: 'build-preference', type: 'feedback' };
  const denied = await run(
    '3',
    'save_memory',
    {
      ...update,
      description: 'Check with npm run check',
      content: 'Use npm run check',
      revision: first.revision,
    },
    false,
  );
  assert.equal(denied.isError, true);
  const blind = await run(
    '3b',
    'save_memory',
    { ...update, description: 'Check with npm run check', content: 'Use npm run check' },
    true,
  );
  assert.equal(blind.isError, true, 'a replace that names no revision is refused');
  assert.match(blind.content, /Use npm run build/, 'with the current text to merge');
  const undescribed = await run(
    '3c',
    'save_memory',
    { scope: 'workspace', key: 'loose', content: 'No type or description' },
    true,
  );
  assert.equal(undescribed.isError, true, 'the model must classify and describe what it saves');
  const replaced = await run(
    '4',
    'save_memory',
    {
      ...update,
      description: 'Check with npm run check',
      content: 'Use npm run check',
      revision: first.revision,
    },
    true,
  );
  assert.equal(replaced.isError, false);
  assert.equal(JSON.parse(replaced.content).text, 'Use npm run check');
  const pinned = await run('5', 'index_document', { path: 'guide.md' }, true);
  assert.equal(pinned.isError, false);
  const recalled = await run('6', 'recall_knowledge', { query: 'staging wave 947' }, false);
  assert.match(recalled.content, /guide.md/);
  const unpinned = await run('7', 'remove_indexed_document', { path: 'guide.md' }, true);
  assert.equal(unpinned.isError, false);
  const forgotten = await run(
    '8',
    'forget_memory',
    {
      scope: 'workspace',
      key: 'build-preference',
      revision: JSON.parse(replaced.content).revision,
    },
    true,
  );
  assert.equal(forgotten.isError, false);
  const empty = await run('9', 'list_memories', {}, false);
  assert.deepEqual(JSON.parse(empty.content), {
    memories: { workspace: [], global: [] },
    documents: [],
  });
  await registry.close();
});

test('one Agent instance refreshes remembered context on the next run', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-refresh-');
  const sessionStore = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = sessionStore.create(root);
  const tools = new ToolRegistry();
  /**
   * What each run was told, whole.
   *
   * Memory used to be a system-prompt section, and asserting on `request.system` was enough. It is announced into
   * the conversation now (§3-4: a section that changes throws away the cacheable prefix, and memory changes
   * whenever it is written), so the thing to assert is what the model was *sent* — and that the reminder is not
   * in the prompt, which is the half that makes the move worth anything.
   */
  const sent: { system: string; messages: Message[] }[] = [];
  const agent = new Agent({
    store: sessionStore,
    tools,
    approve: async () => true,
    provider: {
      async complete(request: ModelRequest) {
        sent.push({ system: request.system, messages: request.messages });
        return {
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  await agent.run({ sessionId: session.id, prompt: 'Hello' });
  const { saveMemoryEntry } = await import('../packages/knowledge/memory.ts');
  await saveMemoryEntry(workspace, 'release', 'Use marker 947 for release');
  await agent.run({ sessionId: session.id, prompt: 'How do we release?' });
  assert.equal(sent.length, 2);
  const told = (index: number) =>
    [sent[index]!.system, ...sent[index]!.messages.map((message) => message.content)].join('\n');
  assert.doesNotMatch(told(0), /marker 947/);
  assert.match(told(1), /marker 947/, 'the memory saved between the runs reaches the next one');
  assert.match(
    sent[1]!.messages.map((message) => message.content).join('\n'),
    /<runtime-context source="memory">/,
  );
  assert.doesNotMatch(sent[1]!.system, /marker 947/, 'and not through the prompt');
  // Close before the fixture cleanup removes the directory.
  await tools.close();
  sessionStore.close();
});

test('a run working outside its project is still reminded of the project memories', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-project-root-');
  const executionRoot = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-worktree-'));
  t.after(() => rm(executionRoot, { recursive: true, force: true }));
  await saveMemoryEntry(workspace, 'release', 'Use marker 512 for release', {
    type: 'feedback',
    description: 'Release with marker 512',
  });
  const sessionStore = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = sessionStore.create(root);
  const tools = new ToolRegistry();
  const sent: Message[][] = [];
  const agent = new Agent({
    store: sessionStore,
    tools,
    approve: async () => true,
    // A worktree child: its files are elsewhere, its project is `root`.
    workspaceRoots: () => ({ projectRoot: root, executionRoot }),
    provider: {
      async complete(request: ModelRequest) {
        sent.push(request.messages);
        return {
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  await agent.run({ sessionId: session.id, prompt: 'How do we release?' });
  assert.match(sent[0]!.map((message) => message.content).join('\n'), /marker 512/);
  await tools.close();
  sessionStore.close();
});

test('knowledge tools in a worktree read and list the project memories', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-tools-root-');
  const executionRoot = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-tools-worktree-'));
  t.after(() => rm(executionRoot, { recursive: true, force: true }));
  await saveMemoryEntry(workspace, 'release', 'Use marker 733', {
    type: 'project',
    description: 'Release marker',
  });
  const source = knowledgeTools(executionRoot, root);
  const registry = new ToolRegistry();
  source.tools.forEach((tool) => registry.register(tool));
  registry.onClose(source.close);
  const context = { signal: new AbortController().signal, approve: async () => false };
  const listed = await registry.execute(
    { id: 'list', name: 'list_memories', arguments: {} },
    context,
  );
  assert.equal(JSON.parse(listed.content).memories.workspace[0].key, 'release');
  const read = await registry.execute(
    { id: 'read', name: 'read_memory', arguments: { scope: 'workspace', key: 'release' } },
    context,
  );
  assert.equal(JSON.parse(read.content).text, 'Use marker 733');
  const recalled = await registry.execute(
    { id: 'recall', name: 'recall_knowledge', arguments: { query: 'marker 733' } },
    context,
  );
  assert.match(recalled.content, /Use marker 733/);
  assert.equal(existsSync(path.join(executionRoot, '.yuantu', 'memory')), false);
  await registry.close();
});

test('a process started for another project reads that project memories', async (t) => {
  const { root, globalDir, workspace } = await memoryFixture(t, 'yuantu-memory-root-setting-');
  const scratch = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-scratch-'));
  const previous = process.env.YUANTU_MEMORY_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.YUANTU_MEMORY_ROOT;
    else process.env.YUANTU_MEMORY_ROOT = previous;
    await rm(scratch, { recursive: true, force: true });
  });
  await saveMemoryEntry(workspace, 'release', 'Use marker 734', {
    type: 'feedback',
    description: 'Release marker',
  });
  // The subprocess provider's child: it works in a scratch directory and is told whose project it serves.
  process.env.YUANTU_MEMORY_ROOT = root;
  const borrowed = memoryPaths(scratch, globalDir).workspace;
  assert.equal(borrowed.dir, workspace.dir);
  assert.match(memorySummary(scratch, globalDir), /workspace\/feedback release: Release marker/);
  assert.equal(recallMemories(scratch, 'marker 734', globalDir)[0]?.key, 'release');
  assert.equal(existsSync(path.join(scratch, '.yuantu', 'memory')), false);
  // Read, never changed: the project is the delegator's, and so is deciding what it remembers.
  await assert.rejects(saveMemoryEntry(borrowed, 'note', 'Child view'), /may read but not change/);
  const current = listMemoryEntries(scratch, globalDir).workspace[0]!;
  await assert.rejects(
    forgetMemoryEntry(borrowed, 'release', current.revision),
    /may read but not change/,
  );
  // Nor is a legacy file migrated in the delegator's project: that is its own Host's write to make.
  const legacyRoot = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-legacy-borrowed-'));
  t.after(() => rm(legacyRoot, { recursive: true, force: true }));
  await mkdir(path.join(legacyRoot, '.yuantu'));
  writeFileSync(
    path.join(legacyRoot, '.yuantu', 'memory.md'),
    '# YuanTu memory\n\n- **old**: Legacy entry (2026-10-01)\n',
  );
  process.env.YUANTU_MEMORY_ROOT = legacyRoot;
  assert.deepEqual(listMemoryEntries(scratch, globalDir).workspace, []);
  assert.equal(existsSync(path.join(legacyRoot, '.yuantu', 'memory')), false);
  assert.equal(existsSync(path.join(legacyRoot, '.yuantu', 'memory.md')), true);
});

// ---- merged from memory.test.ts ----

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-'));
  const globalDir = await mkdtemp(path.join(tmpdir(), 'yuantu-memory-global-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });
  return { root, globalDir, ...memoryPaths(root, globalDir) };
}

test('each memory is its own readable markdown file that round-trips', async (t) => {
  const { workspace } = await fixture(t);
  const saved = await saveMemoryEntry(
    workspace,
    'windows-shell',
    'Use npm.cmd here.\n\nWhy: npm is a ps1 shim.',
    {
      type: 'feedback',
      description: 'Use npm.cmd in this repository',
      session: 'session-1',
      now: new Date('2026-10-30T00:00:00Z'),
    },
  );
  const file = memoryFile(workspace, 'windows-shell');
  const text = await readFile(file, 'utf8');
  assert.equal(
    text,
    '---\nname: windows-shell\ndescription: Use npm.cmd in this repository\ntype: feedback\nupdated: 2026-10-30\nsession: session-1\n---\n\nUse npm.cmd here.\n\nWhy: npm is a ps1 shim.\n',
  );
  const parsed = parseMemoryEntry('windows-shell', Buffer.from(text));
  assert.deepEqual(parsed.entry, saved);
  assert.equal(
    renderMemoryEntry(parsed.entry, parsed.extra),
    text,
    'a parsed file renders back to itself',
  );
});

test('hand-written fields, notes and files without frontmatter survive', async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(workspace.dir, { recursive: true });
  await writeFile(
    path.join(workspace.dir, MEMORY_NOTES_FILE),
    'My own notes: staging is read-only.\n',
  );
  await writeFile(
    path.join(workspace.dir, 'plain.md'),
    'Written by hand, no header.\r\nSecond line.\r\n',
  );
  await writeFile(
    path.join(workspace.dir, 'tagged.md'),
    '---\nname: tagged\nowner: platform team\ndescription: ends in dashes ---\ntype: reference\nupdated: 2026-01-02\n---\n\nbody\n',
  );
  const before = readMemoryDirectory(workspace);
  assert.equal(before.notes, 'My own notes: staging is read-only.');
  assert.deepEqual(
    before.entries.map((entry) => [entry.key, entry.type, entry.description]),
    [
      ['plain', 'project', 'Written by hand, no header.'],
      ['tagged', 'reference', 'ends in dashes ---'],
    ],
  );
  const tagged = before.entries[1]!;
  await saveMemoryEntry(workspace, 'tagged', 'new body', {
    type: 'reference',
    revision: tagged.revision,
  });
  assert.match(await readFile(memoryFile(workspace, 'tagged'), 'utf8'), /^owner: platform team$/m);
  assert.equal(readMemoryDirectory(workspace).notes, 'My own notes: staging is read-only.');
});

test('replacing or forgetting an entry requires the revision it was based on', async (t) => {
  const { workspace } = await fixture(t);
  const first = await saveMemoryEntry(workspace, 'build', 'Use npm run build', {
    now: new Date('2026-01-01T00:00:00Z'),
  });
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'build', 'Use npm run check'),
    (error: unknown) =>
      error instanceof MemoryConflictError &&
      error.current?.text === 'Use npm run build' &&
      error.message.includes(first.revision),
  );
  const replaced = await saveMemoryEntry(workspace, 'build', 'Use npm run check', {
    revision: first.revision,
    now: new Date('2026-03-04T00:00:00Z'),
  });
  assert.equal(replaced.updatedAt, '2026-03-04');
  assert.notEqual(replaced.revision, first.revision);
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'build', 'stale', { revision: first.revision }),
    MemoryConflictError,
    'an outdated revision is refused',
  );
  await assert.rejects(() => forgetMemoryEntry(workspace, 'build', undefined), MemoryConflictError);
  await assert.rejects(
    () => forgetMemoryEntry(workspace, 'build', first.revision),
    MemoryConflictError,
  );
  assert.equal(readMemoryDirectory(workspace).entries[0]!.text, 'Use npm run check');
  await forgetMemoryEntry(workspace, 'build', replaced.revision);
  assert.deepEqual(readMemoryDirectory(workspace).entries, []);
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'build', 'again', { revision: replaced.revision }),
    /no longer exists/,
  );
});

test('concurrent saves of different keys never lose an entry', async (t) => {
  const { workspace } = await fixture(t);
  const keys = Array.from({ length: 12 }, (_, index) => `key-${index}`);
  await Promise.all(keys.map((key) => saveMemoryEntry(workspace, key, `value of ${key}`)));
  assert.deepEqual(
    readMemoryDirectory(workspace)
      .entries.map((entry) => entry.key)
      .sort(),
    [...keys].sort(),
  );
});

test('concurrent replaces based on one revision let exactly one through', async (t) => {
  const { workspace } = await fixture(t);
  const base = await saveMemoryEntry(workspace, 'shared', 'base');
  const outcomes = await Promise.allSettled(
    ['first', 'second', 'third'].map((text) =>
      saveMemoryEntry(workspace, 'shared', text, { revision: base.revision }),
    ),
  );
  const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(won.length, 1);
  for (const outcome of outcomes)
    if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof MemoryConflictError);
  assert.equal(
    readMemoryDirectory(workspace).entries[0]!.text,
    (won[0] as PromiseFulfilledResult<{ text: string }>).value.text,
  );
});

test('keys, types and content are validated instead of written blindly', async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(() => saveMemoryEntry(workspace, 'Not A Key', 'x'), /Invalid memory key/);
  await assert.rejects(() => saveMemoryEntry(workspace, '', 'x'), /Invalid memory key/);
  for (const reserved of ['con', 'nul', 'com1', 'lpt9', 'aux.notes'])
    await assert.rejects(() => saveMemoryEntry(workspace, reserved, 'x'), /reserved by Windows/);
  await assert.rejects(() => saveMemoryEntry(workspace, 'ok', '   '), /must not be empty/);
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'ok', 'x'.repeat(memoryLimits.text + 1)),
    /exceeds/,
  );
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'ok', 'x', { type: 'note' }),
    /Invalid memory type/,
  );
  await assert.rejects(
    () =>
      saveMemoryEntry(workspace, 'ok', 'x', {
        description: 'd'.repeat(memoryLimits.description + 1),
      }),
    /description exceeds/,
  );
  await assert.rejects(() => forgetMemoryEntry(workspace, 'missing', undefined), /No memory named/);
  const multiline = await saveMemoryEntry(workspace, 'multiline', '  first\r\n\r\nsecond  ');
  assert.equal(multiline.text, 'first\n\nsecond', 'line breaks are kept, CRLF becomes LF');
  assert.equal(multiline.description, 'first');
  assert.equal(multiline.type, 'project', 'a workspace memory defaults to project');
});

test('the entry count is bounded so the directory cannot grow without limit', async (t) => {
  const { workspace } = await fixture(t);
  for (let index = 0; index < memoryLimits.entries; index++)
    await saveMemoryEntry(workspace, `entry-${index}`, `value ${index}`);
  await assert.rejects(() => saveMemoryEntry(workspace, 'one-too-many', 'x'), /limit reached/);
  const first = readMemoryDirectory(workspace).entries.find((entry) => entry.key === 'entry-0')!;
  await forgetMemoryEntry(workspace, 'entry-0', first.revision);
  assert.equal((await saveMemoryEntry(workspace, 'one-too-many', 'x')).key, 'one-too-many');
});

test('a single-file memory.md from earlier versions is migrated once and kept aside', async (t) => {
  const { workspace, global } = await fixture(t);
  await mkdir(path.dirname(workspace.dir), { recursive: true });
  const legacy =
    '# YuanTu memory\n\n<!-- One bullet per managed memory. Text outside these bullets is kept as written. -->\n\nMy own notes.\n\n- **build**: Use npm run build (2026-01-02)\n- **con**: Reserved name (2026-01-03)\n';
  await writeFile(`${workspace.dir}.md`, legacy);
  await writeFile(`${global.dir}.md`, '- **language**: Respond in Chinese (2026-02-03)\n');
  const migrated = readMemoryDirectory(workspace);
  assert.deepEqual(
    migrated.entries.map((entry) => [
      entry.key,
      entry.type,
      entry.text,
      entry.updatedAt,
      entry.session,
    ]),
    [
      ['build', 'project', 'Use npm run build', '2026-01-02', 'migrated'],
      ['con-entry', 'project', 'Reserved name', '2026-01-03', 'migrated'],
    ],
  );
  assert.match(migrated.notes, /^My own notes\./);
  assert.match(migrated.notes, /con -> con-entry/);
  assert.equal(
    await readFile(`${workspace.dir}.md.migrated`, 'utf8'),
    legacy,
    'the old file is kept',
  );
  assert.equal(
    readMemoryDirectory(global).entries[0]!.type,
    'user',
    'user-wide entries become user memories',
  );
  // A crash after the directory was renamed into place but before the legacy file was moved aside.
  await writeFile(`${workspace.dir}.md`, '- **build**: Older text (2025-01-01)\n');
  const again = readMemoryDirectory(workspace);
  assert.equal(again.entries.find((entry) => entry.key === 'build')!.text, 'Use npm run build');
  assert.ok(existsSync(`${workspace.dir}.md.migrated`));
  assert.equal(existsSync(`${workspace.dir}.md`), false);
});

test('the system prompt reminder prefers workspace entries over user-wide ones', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  assert.equal(memorySummary(root, globalDir), '', 'no memory means no reminder at all');
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  await saveMemoryEntry(workspace, 'build', 'Use the local build 348');
  for (let index = 0; index < 4; index++)
    await saveMemoryEntry(workspace, `extra-${index}`, `filler ${index}`);
  const summary = memorySummary(root, globalDir);
  assert.match(summary, /local build 348/);
  assert.match(summary, /Respond in Chinese/);
  assert.match(summary, /recall_knowledge/);
  assert.doesNotMatch(summary, /omitted/);
  assert.ok(
    summary.indexOf('local build 348') < summary.indexOf('Respond in Chinese'),
    'workspace entries are the ones most likely to change the current task',
  );
});

test('the reminder is an index of every memory, not a dozen entries of text', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  await saveMemoryEntry(global, 'language', 'Respond in Chinese', { type: 'user' });
  await saveMemoryEntry(workspace, 'old-decision', 'x'.repeat(400), {
    type: 'project',
    description: 'Staging is read-only',
    now: new Date('2026-01-01T00:00:00Z'),
  });
  await saveMemoryEntry(workspace, 'new-decision', 'Long project text '.repeat(10), {
    type: 'project',
    description: 'Release in waves',
    now: new Date('2026-05-01T00:00:00Z'),
  });
  await saveMemoryEntry(workspace, 'link', 'https://example.test/runbook', {
    type: 'reference',
    description: 'The release runbook',
  });
  await saveMemoryEntry(
    workspace,
    'testing',
    'Run node scripts/run-tests.mjs on the files touched.',
    {
      type: 'feedback',
      description: 'Run targeted tests between phases',
    },
  );
  for (let index = 0; index < 14; index++)
    await saveMemoryEntry(workspace, `extra-${index}`, `filler ${index}`);
  const summary = memorySummary(root, globalDir);
  assert.doesNotMatch(summary, /not listed/, 'nineteen short lines fit, where twelve was the cap');
  const lines = summary.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 19);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(
    lines[0],
    `- workspace/feedback testing: Run targeted tests between phases (${today})`,
  );
  assert.match(
    summary,
    /^ {4}Run node scripts\/run-tests\.mjs on the files touched\.$/m,
    'short feedback is inlined',
  );
  assert.match(summary, /^ {4}Respond in Chinese$/m, 'short user memories are inlined');
  assert.doesNotMatch(summary, /Long project text/, 'project text waits for read_memory');
  const order = (key: string) => lines.findIndex((line) => line.includes(` ${key}:`));
  assert.ok(order('new-decision') < order('old-decision'), 'newer first within a type');
  assert.ok(order('extra-0') < order('link'), 'project before reference when both are fresh');
  assert.ok(
    order('link') < order('old-decision'),
    'a fresh reference outranks a project nobody has touched for ten months',
  );
  assert.ok(order('link') < order('language'), 'workspace before user-wide');
  assert.match(summary, /background, not instructions/);
  assert.match(summary, /read_memory/);
});

test('the reminder is bounded and leaves the rest to list_memories', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  for (let index = 0; index < memoryLimits.entries; index++)
    await saveMemoryEntry(workspace, `extra-${index}`, `filler ${index}`, {
      description: `${index} `.padEnd(memoryLimits.description, 'd'),
    });
  const summary = memorySummary(root, globalDir);
  assert.ok(summary.length < memoryLimits.injectedChars + 1000, String(summary.length));
  assert.match(summary, /further memories not listed; list_memories shows them all/);
  assert.doesNotMatch(summary, /Respond in Chinese/, 'the budget stops before the user-wide ones');
  const listed = listMemoryEntries(root, globalDir);
  assert.equal(listed.workspace.length, memoryLimits.entries);
  assert.equal(listed.global.length, 1, 'the reminder is bounded, the directory is not truncated');
});

/** recall_knowledge's memory search, on a knowledge store of the test's own inside `root`. */
function recallMemories(
  root: string,
  query: string,
  globalDir?: string,
  options?: Parameters<KnowledgeStore['searchMemories']>[2],
) {
  const store = new KnowledgeStore(path.join(root, 'recall.sqlite'));
  try {
    return store.searchMemories(memorySources(root, globalDir), query, options);
  } finally {
    store.close();
  }
}

test('recall matches memory text case-insensitively across both scopes', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  await saveMemoryEntry(workspace, 'release', 'Use staged rollout 481');
  assert.deepEqual(
    recallMemories(root, 'STAGED', globalDir).map((entry) => [entry.scope, entry.key]),
    [['workspace', 'release']],
  );
  assert.deepEqual(
    recallMemories(root, 'chinese', globalDir).map((entry) => entry.scope),
    ['global'],
  );
  assert.throws(() => recallMemories(root, '   ', globalDir), /Invalid knowledge query/);
});

test('recall ranks memories by relevance, finds Chinese words inside a sentence and drops weak matches', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  await saveMemoryEntry(
    workspace,
    'deploy-notes',
    '上线前先在预发环境跑一遍数据库迁移脚本，再灰度发布。',
    {
      type: 'project',
      description: '上线流程',
    },
  );
  await saveMemoryEntry(workspace, 'migration', '数据库迁移必须可回滚。', {
    type: 'feedback',
    description: '数据库迁移的要求',
  });
  await saveMemoryEntry(workspace, 'unrelated', 'The office coffee machine is on floor 3.', {
    type: 'reference',
    description: 'Coffee',
  });
  const hits = recallMemories(root, '数据库迁移', globalDir);
  assert.equal(hits[0]?.key, 'migration', 'a description naming the whole query comes first');
  assert.deepEqual(hits.map((hit) => hit.key).sort(), ['deploy-notes', 'migration']);
  assert.deepEqual(
    recallMemories(root, '迁移', globalDir, { types: ['project'] }).map((hit) => hit.key),
    ['deploy-notes'],
  );
  assert.equal(recallMemories(root, '数据库迁移', globalDir, { limit: 1 }).length, 1);
  // Many memories match a common word; only those close to the best survive the relevance floor.
  for (let index = 0; index < 12; index++)
    await saveMemoryEntry(workspace, `filler-${index}`, `release ${'filler '.repeat(200)}`, {
      description: `Filler ${index}`,
    });
  await saveMemoryEntry(
    workspace,
    'release-train',
    'Release every Tuesday from the release branch.',
    {
      type: 'project',
      description: 'Release train schedule',
    },
  );
  const release = recallMemories(root, 'release train', globalDir, { limit: 20 });
  assert.equal(release[0]?.key, 'release-train');
  assert.ok(
    !release.some((hit) => hit.key.startsWith('filler-')),
    JSON.stringify(release.map((hit) => hit.key)),
  );
});

test('recall returns an excerpt of a long memory and follows edits made by hand', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  const long = `${'Background paragraph. '.repeat(40)}The deploy key rotates on the first Monday. ${'Trailing note. '.repeat(40)}`;
  await saveMemoryEntry(workspace, 'rotation', long, {
    type: 'project',
    description: 'Key rotation',
  });
  const [hit] = recallMemories(root, 'first Monday', globalDir);
  assert.ok(hit);
  assert.ok(hit.excerpt.length <= 301, String(hit.excerpt.length));
  assert.match(hit.excerpt, /first Monday/);
  assert.equal('text' in hit, false, 'the full text is read_memory');
  // The file is the source of truth: an edit outside the tools is searchable on the next recall.
  const file = memoryFile(workspace, 'rotation');
  await writeFile(file, (await readFile(file, 'utf8')).replace('first Monday', 'last Friday'));
  assert.deepEqual(recallMemories(root, 'first Monday', globalDir), []);
  assert.equal(recallMemories(root, 'last Friday', globalDir)[0]?.key, 'rotation');
  await rm(file);
  assert.deepEqual(recallMemories(root, 'last Friday', globalDir), []);
});

test('recall_knowledge filters memories, caps them and names the file each one lives in', async (t) => {
  const { root, globalDir, workspace, global } = await memoryFixture(
    t,
    'yuantu-memory-recall-tool-',
  );
  await saveMemoryEntry(global, 'language', 'Answer in Chinese, marker 951', { type: 'user' });
  await saveMemoryEntry(workspace, 'release', 'Release marker 951', { type: 'project' });
  const registry = memoryToolRegistry(root);
  const context = { signal: new AbortController().signal, approve: async () => false };
  const recall = async (args: Record<string, unknown>) => {
    const outcome = await registry.execute(
      { id: 'recall', name: 'recall_knowledge', arguments: args },
      context,
    );
    assert.equal(outcome.isError, false, outcome.content);
    return JSON.parse(outcome.content).results as {
      scope: string;
      title: string;
      source: string;
    }[];
  };
  const both = await recall({ query: 'marker 951' });
  assert.deepEqual(both.map((hit) => hit.scope).sort(), ['global', 'workspace']);
  const user = both.find((hit) => hit.scope === 'global')!;
  // The configured directory, not a hard-coded ~/.yuantu.
  assert.ok(user.source.endsWith(`${path.basename(globalDir)}/memory/language.md`), user.source);
  assert.equal(both.find((hit) => hit.scope === 'workspace')!.source, '.yuantu/memory/release.md');
  assert.deepEqual(
    (await recall({ query: 'marker 951', memory_scope: 'workspace' })).map((hit) => hit.title),
    ['release'],
  );
  assert.deepEqual(
    (await recall({ query: 'marker 951', memory_types: ['user'] })).map((hit) => hit.title),
    ['language'],
  );
  assert.equal((await recall({ query: 'marker 951', limit: 1 })).length, 1);
  assert.ok(memoryUsage(workspace).release?.lastUsed, 'a top recall counts as a use');
  await registry.close();
});

/** Sets one setting for the rest of the test and puts the previous value back afterwards. */
function withSetting(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}
/** The caller closes it: the fixture's directory is removed by an earlier `t.after`, and an open index blocks that. */
function memoryToolRegistry(root: string): ToolRegistry {
  const source = knowledgeTools(root);
  const registry = new ToolRegistry();
  source.tools.forEach((tool) => registry.register(tool));
  registry.onClose(source.close);
  return registry;
}
const readContext = () => ({ signal: new AbortController().signal, approve: async () => true });

test('a memory that carries a credential is refused, prose about credentials is not', async (t) => {
  const { workspace } = await fixture(t);
  // Built from parts so the fixture is not itself a credential a scanner would flag.
  const samples: [string, RegExp][] = [
    [`Key is sk-ant-${'a1'.repeat(16)}`, /Anthropic API key/],
    [`Use ghp_${'A1'.repeat(18)} for the bot`, /GitHub token/],
    [`AWS: AKIA${'ABCD1234'.repeat(2)}`, /AWS access key/],
    [`-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nabc`, /private key/],
    ['Connect to postgres://app:hunter22@db.internal/app', /URL with a password/],
    [`password = "${'q8'.repeat(9)}"`, /credential assignment/],
  ];
  for (const [text, kind] of samples)
    await assert.rejects(saveMemoryEntry(workspace, 'leak', text), kind);
  // The value is never echoed back in the refusal.
  await assert.rejects(saveMemoryEntry(workspace, 'leak', samples[0]![0]), (error: Error) => {
    assert.doesNotMatch(error.message, /sk-ant-/);
    return true;
  });
  // A description is checked too: it is the line every later session sees.
  await assert.rejects(
    saveMemoryEntry(workspace, 'leak', 'Release bot', { description: samples[1]![0] }),
    /GitHub token/,
  );
  // A value the deployment was configured with is matched exactly, whatever its shape.
  withSetting(t, 'YUANTU_SEARCH_API_KEY', 'plain-looking-value');
  await assert.rejects(
    saveMemoryEntry(workspace, 'leak', 'Search uses plain-looking-value'),
    /value of YUANTU_SEARCH_API_KEY/,
  );
  for (const prose of [
    'The API token lives in 1Password under "release bot"; ask before rotating it.',
    'password: see the team vault',
    'Set YUANTU_API_KEY in .env, never in code.',
  ])
    await saveMemoryEntry(workspace, `prose-${prose.length}`, prose);
  assert.equal(readMemoryDirectory(workspace).entries.length, 3);
});

test('YUANTU_MEMORY=read keeps reading and changes nothing on disk', async (t) => {
  const { root, globalDir, workspace } = await memoryFixture(t, 'yuantu-memory-mode-read-');
  await saveMemoryEntry(workspace, 'release', 'Use marker 735', { type: 'feedback' });
  withSetting(t, 'YUANTU_MEMORY', 'read');
  const registry = memoryToolRegistry(root);
  const names = registry.specs().map((spec) => spec.name);
  assert.ok(names.includes('read_memory') && names.includes('list_memories'));
  assert.ok(!names.includes('save_memory') && !names.includes('forget_memory'));
  await assert.rejects(saveMemoryEntry(workspace, 'other', 'Text'), /read-only in this deployment/);
  const summary = memorySummary(root, globalDir);
  assert.match(summary, /release/);
  assert.match(summary, /read-only in this deployment/);
  assert.doesNotMatch(summary, /save_memory/);
  assert.match(agentSystemPrompt('read'), /read-only in this deployment/);
  assert.doesNotMatch(agentSystemPrompt('read'), /save_memory/);
  // Reading records nothing either: the record the earlier save started is left as it was.
  const before = await readFile(memoryUsageFile(workspace), 'utf8');
  await registry.execute(
    { id: 'read', name: 'read_memory', arguments: { scope: 'workspace', key: 'release' } },
    readContext(),
  );
  assert.equal(await readFile(memoryUsageFile(workspace), 'utf8'), before);
  assert.equal(memoryUsage(workspace).release?.lastUsed, undefined);
  await registry.close();
});

test('YUANTU_MEMORY=off is a run with no memory at all', async (t) => {
  const { root, globalDir, workspace } = await memoryFixture(t, 'yuantu-memory-mode-off-');
  await saveMemoryEntry(workspace, 'release', 'Use marker 736', { type: 'feedback' });
  withSetting(t, 'YUANTU_MEMORY', 'off');
  const registry = memoryToolRegistry(root);
  const names = registry.specs().map((spec) => spec.name);
  for (const name of ['read_memory', 'save_memory', 'forget_memory'])
    assert.ok(!names.includes(name), name);
  // Kept for the indexed documents, which they also cover.
  assert.ok(names.includes('recall_knowledge') && names.includes('list_memories'));
  assert.equal(memorySummary(root, globalDir), '');
  assert.deepEqual(memorySources(root, globalDir), []);
  assert.doesNotMatch(agentSystemPrompt('off'), /# Memory|save_memory/);
  assert.equal(agentSystemPrompt('on'), AGENT_SYSTEM_PROMPT);
  await registry.close();
});

test('reading or recalling a memory records the day it was used, without touching the entry', async (t) => {
  const { root, workspace, global } = await memoryFixture(t, 'yuantu-memory-usage-');
  const saved = await saveMemoryEntry(workspace, 'release', 'Use marker 737');
  await saveMemoryEntry(global, 'language', 'Respond in Chinese, marker 737');
  await saveMemoryEntry(workspace, 'unused', 'Never asked for');
  const registry = memoryToolRegistry(root);
  const listUsed = async () => {
    const listed = await registry.execute(
      { id: 'list', name: 'list_memories', arguments: {} },
      readContext(),
    );
    const memories = JSON.parse(listed.content).memories as Record<
      'workspace' | 'global',
      { key: string; lastUsed?: string; revision: string }[]
    >;
    return memories;
  };
  // Listing and the reminder are not use.
  assert.ok((await listUsed()).workspace.every((entry) => entry.lastUsed === undefined));
  await registry.execute(
    { id: 'recall', name: 'recall_knowledge', arguments: { query: 'marker 737' } },
    readContext(),
  );
  const today = new Date().toISOString().slice(0, 10);
  const used = await listUsed();
  assert.equal(used.workspace.find((entry) => entry.key === 'release')?.lastUsed, today);
  assert.equal(used.workspace.find((entry) => entry.key === 'unused')?.lastUsed, undefined);
  assert.equal(used.global[0]?.lastUsed, today);
  // The entry file is untouched, so the revision someone is saving against still holds.
  assert.equal(used.workspace.find((entry) => entry.key === 'release')?.revision, saved.revision);
  // Kept beside the directory, under the part of `.yuantu` that git excludes.
  assert.equal(memoryUsageFile(workspace), path.join(root, '.yuantu', 'memory-usage.json'));
  await recordMemoryUse(workspace, ['unused'], new Date('2026-01-02T00:00:00Z'));
  assert.equal(memoryUsage(workspace).unused?.lastUsed, '2026-01-02');
  await registry.execute(
    { id: 'read', name: 'read_memory', arguments: { scope: 'workspace', key: 'unused' } },
    readContext(),
  );
  // A second day counts; a second use on the same day does not, so a key is rewritten at most once a day.
  assert.deepEqual(memoryUsage(workspace).unused, {
    firstSeen: today,
    lastUsed: today,
    usedDays: 2,
  });
  await registry.execute(
    { id: 'again', name: 'read_memory', arguments: { scope: 'workspace', key: 'unused' } },
    readContext(),
  );
  assert.equal(memoryUsage(workspace).unused?.usedDays, 2);
  // Every entry has a record from its first day, used or not: the start of a clean-up's grace period.
  assert.deepEqual(memoryUsage(global).language, {
    firstSeen: today,
    lastUsed: today,
    usedDays: 1,
  });
  // A forgotten memory leaves the record, and so does one deleted by hand.
  await forgetMemoryEntry(
    workspace,
    'unused',
    listMemoryEntries(root).workspace.find((e) => e.key === 'unused')!.revision,
  );
  assert.equal(memoryUsage(workspace).unused, undefined);
  await rm(memoryFile(workspace, 'release'));
  await recordMemoryUse(global, ['language']);
  await recordMemoryUse(workspace, []);
  writeFileSync(memoryUsageFile(workspace), '{ not json');
  assert.deepEqual(memoryUsage(workspace), {});
  await registry.close();
});

/**
 * What the store asks the database to do, counted at the driver.
 *
 * The claims below are about *SQL*, not about returned values: how many statements a search prepares, and
 * whether refreshing unchanged documents opens a write transaction. Neither is visible in a result, and
 * neither can be inferred from a stopwatch. Counting at `DatabaseSync.prototype` sees every statement whichever
 * private field holds the connection, and it is restored before the test returns.
 */
function countSql<T>(body: () => T): { value: T; statements: number; writeTransactions: number } {
  const proto = DatabaseSync.prototype as unknown as {
    exec: (sql: string, ...rest: unknown[]) => unknown;
    prepare: (sql: string, ...rest: unknown[]) => unknown;
  };
  const exec = proto.exec;
  const prepare = proto.prepare;
  let statements = 0;
  let writeTransactions = 0;
  proto.exec = function (this: unknown, sql: string, ...rest: unknown[]): unknown {
    // `BEGIN IMMEDIATE`, not `BEGIN`: the store asks for the write lock up front, and a deferred read
    // transaction is not what is being claimed here.
    if (/^\s*BEGIN\s+IMMEDIATE/i.test(String(sql))) writeTransactions++;
    return Reflect.apply(exec, this, [sql, ...rest]);
  };
  proto.prepare = function (this: unknown, sql: string, ...rest: unknown[]): unknown {
    statements++;
    return Reflect.apply(prepare, this, [sql, ...rest]);
  };
  try {
    return { value: body(), statements, writeTransactions };
  } finally {
    proto.exec = exec;
    proto.prepare = prepare;
  }
}
/** A store whose database file is isolated from the user's real one, plus its workspace root. */
async function documentFixture(
  t: test.TestContext,
): Promise<{ root: string; store: KnowledgeStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-refresh-'));
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  // One hook, in this order: the connection has to close before its file can be removed, and two hooks would
  // let the removal run first.
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
/** Pins the documents named `doc-N.md` for `from <= N < to`, each carrying the word `alpha`. */
async function pinDocuments(
  root: string,
  store: KnowledgeStore,
  from: number,
  to: number,
): Promise<void> {
  for (let index = from; index < to; index += 1) {
    await writeFile(path.join(root, `doc-${index}.md`), `Document number ${index} carries alpha.`);
    store.pinDocument(root, `doc-${index}.md`);
  }
}

test('an unchanged document refresh is linear and starts no write transaction', async (t) => {
  /**
   * Search refreshes the index, so a search *can* write — but only when a document actually changed. The old
   * shape refreshed by calling `pinDocument` for every pinned document, and `pinDocument` opened
   * `BEGIN IMMEDIATE` before it looked at the digest, so a search over N unchanged documents took N write
   * locks and, on the unchanged path, ran the whole `listDocuments` query once per document as well: quadratic
   * statements in a read-only request, each one holding the database's single writer.
   *
   * The measurement is 3, 32 and 64 documents because linearity is what is claimed; a single size cannot tell
   * a linear count from a quadratic one. The counts are reported rather than turned into a latency claim —
   * these are SQL round trips, and nothing here measures elapsed time.
   */
  const { root, store } = await documentFixture(t);
  await pinDocuments(root, store, 0, 3);
  store.search(root, 'alpha');
  const three = countSql(() => store.search(root, 'alpha'));
  await pinDocuments(root, store, 3, 32);
  store.search(root, 'alpha');
  const thirtyTwo = countSql(() => store.search(root, 'alpha'));
  await pinDocuments(root, store, 32, 64);
  store.search(root, 'alpha');
  const sixtyFour = countSql(() => store.search(root, 'alpha'));
  assert.deepEqual(
    [store.listDocuments(root).length, store.search(root, 'alpha').length],
    [64, 8],
    'the measurement really ran over 64 pinned documents',
  );
  for (const [size, measured] of [
    [3, three],
    [32, thirtyTwo],
    [64, sixtyFour],
  ] as const)
    t.diagnostic(
      `${size} unchanged documents: ${measured.statements} statements, ${measured.writeTransactions} write transactions`,
    );

  assert.equal(three.value.length, 3, 'every pinned document is still found');
  assert.equal(sixtyFour.value.length, 8, 'the result limit still bounds the answer');
  for (const [size, measured] of [
    [3, three],
    [32, thirtyTwo],
    [64, sixtyFour],
  ] as const)
    assert.equal(
      measured.writeTransactions,
      0,
      `${size} unchanged documents must not take the write lock: refreshing is not writing`,
    );
  /**
   * The marginal cost of one more document, which is what "linear" means here: one digest probe and one chunk
   * count, so at most three statements. A per-document `listDocuments` — let alone the transaction it used to
   * sit inside — makes this number grow with the document count instead, which the second bound states as the
   * absolute budget it is.
   */
  const marginal = (sixtyFour.statements - thirtyTwo.statements) / (64 - 32);
  const marginal32 = (thirtyTwo.statements - three.statements) / (32 - 3);
  t.diagnostic(`marginal statements per document: ${marginal32} at 3→32, ${marginal} at 32→64`);
  assert.ok(
    marginal <= 3 && marginal32 <= 3,
    `one more unchanged document may cost at most a constant: ${marginal32} and ${marginal} statements`,
  );
  assert.ok(
    sixtyFour.statements <= 4 * (64 + 2),
    `and the whole refresh stays within a linear budget: 64 documents took ${sixtyFour.statements}`,
  );
});

test('listDocuments answers from one query instead of one per document', async (t) => {
  // The other half of the quadratic shape: `listDocuments` counted chunks by asking once per document, and
  // `list_memories` calls it directly. One aggregate is not a micro-optimisation here — it is the difference
  // between N+1 round trips and one.
  const { root, store } = await documentFixture(t);
  await pinDocuments(root, store, 0, 40);
  const listed = countSql(() => store.listDocuments(root));
  assert.equal(listed.statements, 1, 'one aggregate query, not one query per pinned document');
  assert.equal(listed.value.length, 40);
  assert.ok(
    listed.value.every((document) => document.chunks === 1),
    'and it still reports the chunk count each document actually has',
  );
  assert.deepEqual(
    listed.value.map((document) => document.path),
    [...listed.value.map((document) => document.path)].sort(),
    'still ordered by path',
  );
});

test('a changed document is re-indexed in one write transaction, and nothing else is rewritten', async (t) => {
  // The other side of "unchanged is free": a real change must still land, atomically, and must replace the old
  // content rather than adding to it.
  const { root, store } = await documentFixture(t);
  await pinDocuments(root, store, 0, 5);
  assert.equal(store.search(root, 'alpha').length, 5);
  await writeFile(path.join(root, 'doc-2.md'), 'Document number 2 was rewritten to carry zeta.');
  const changed = countSql(() => store.search(root, 'zeta'));
  assert.equal(
    changed.writeTransactions,
    1,
    'one document changed, so exactly one write transaction — not one per pinned document',
  );
  assert.equal(changed.value[0]?.source, 'doc-2.md');
  assert.equal(store.search(root, 'alpha').length, 4, 'the old content left the index with it');
  assert.equal(store.listDocuments(root).length, 5, 'and the document is still pinned');
});

test('an unchanged pinned document is verified by metadata instead of being read again', async (t) => {
  /**
   * The other half of "unchanged is free": the old refresh decided a document was unchanged by *reading* it and
   * comparing digests, so asking the same question twice paid for the whole corpus twice. A stat answers the same
   * question for an unchanged file, and the digest check inside `pinDocument` stays the authority for one that
   * moved.
   */
  const { root, store } = await documentFixture(t);
  await pinDocuments(root, store, 0, 5);
  store.search(root, 'alpha');
  const before = store.refreshCounts();
  store.search(root, 'alpha');
  const after = store.refreshCounts();
  assert.equal(
    after.verified - before.verified,
    5,
    'five unchanged documents were verified cheaply',
  );
  assert.equal(after.reread - before.reread, 0, 'and none of them was read again');

  // A change still costs a read, and still lands in the index.
  await writeFile(path.join(root, 'doc-3.md'), 'Document number 3 was rewritten to carry omega.');
  const changed = store.search(root, 'omega');
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.source, 'doc-3.md');
  const afterChange = store.refreshCounts();
  assert.ok(afterChange.reread > after.reread, 'the changed document was read again');
});

test('a document that cannot be re-read keeps its index entry; a deleted one is unpinned', async (t) => {
  /**
   * A failed re-read is not a deletion. `resourceText` refuses a transient non-UTF-8 write and a file that
   * briefly grew past the read limit exactly as it refuses a missing file, so the refresh has to distinguish
   * them itself — otherwise an editor's half-written save permanently discards a document, silently, with no
   * error the user could act on.
   */
  const { root, store } = await documentFixture(t);
  await writeFile(path.join(root, 'kept.md'), 'keeper alpha');
  await writeFile(path.join(root, 'lost.md'), 'lost beta');
  store.pinDocument(root, 'kept.md');
  store.pinDocument(root, 'lost.md');

  await writeFile(path.join(root, 'kept.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  assert.equal(
    store.search(root, 'keeper')[0]?.source,
    'kept.md',
    'the last good content still answers',
  );
  assert.equal(store.listDocuments(root).length, 2, 'a non-UTF-8 write does not unpin');

  await writeFile(path.join(root, 'kept.md'), 'x'.repeat(40 * 1024));
  assert.equal(
    store.search(root, 'keeper')[0]?.source,
    'kept.md',
    'nor does growing past the read limit',
  );
  assert.equal(store.listDocuments(root).length, 2);

  await rm(path.join(root, 'lost.md'));
  assert.deepEqual(store.search(root, 'beta'), [], 'a missing file is genuinely gone');
  assert.deepEqual(
    store.listDocuments(root).map((document) => document.path),
    ['kept.md'],
  );
});

test('Chinese words separated in a query match a pinned document, with no substring of the whole query', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-cjk-'));
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  // One hook, closing first: Windows refuses to delete a database file that is still open.
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'notes.md'), '上线前先执行数据库迁移，再运行冒烟测试。');
  await writeFile(path.join(root, 'other.md'), '迁移脚本放在 scripts 目录。');
  store.pinDocument(root, 'notes.md');
  store.pinDocument(root, 'other.md');
  // Neither query is a substring of either file, so only the index can answer: it used to hold each
  // clause as one token, and both came back empty.
  assert.deepEqual(
    store.search(root, '数据库 冒烟').map((item) => item.source),
    ['notes.md'],
  );
  assert.deepEqual(
    store.search(root, '迁移 脚本').map((item) => item.source),
    ['other.md'],
  );
  // The stored chunk is the document as written; only the index is segmented.
  assert.equal(
    store.search(root, '数据库')[0]?.content,
    '上线前先执行数据库迁移，再运行冒烟测试。',
  );
  store.unpinDocument(root, 'notes.md');
  assert.deepEqual(store.search(root, '数据库 冒烟'), []);
});

test('an index written by the old raw-copy triggers is rebuilt once, and the triggers do not come back', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-cjk-legacy-'));
  const file = path.join(root, 'knowledge.sqlite');
  await writeFile(path.join(root, 'notes.md'), '上线前先执行数据库迁移，再运行冒烟测试。');
  // The shape an earlier build left: triggers copying the columns verbatim into the index.
  const first = new KnowledgeStore(file);
  first.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;
    CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_items BEGIN
      DELETE FROM knowledge_fts WHERE rowid=old.rowid; END;`);
  legacy
    .prepare(
      "INSERT INTO knowledge_documents(id,scope,path,digest,updated_at) VALUES('d',?,'notes.md','x','2026-01-01')",
    )
    .run(realpathSync(root));
  legacy
    .prepare(
      "INSERT INTO knowledge_items(id,scope,kind,title,content,source,document_id,updated_at) VALUES('d:0',?,'document','notes.md',?,'notes.md','d','2026-01-01')",
    )
    .run(realpathSync(root), '上线前先执行数据库迁移，再运行冒烟测试。');
  legacy.close();

  const store = new KnowledgeStore(file);
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(async () => {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()?.n,
    0,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_fts').get()?.n, 1);
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM knowledge_fts WHERE knowledge_fts MATCH ?')
      .get('"​数​据​库​"')?.n,
    1,
    'the legacy row is in the index in its segmented form',
  );
});

test('a chunk boundary never splits a character outside the BMP', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-surrogate-'));
  const file = path.join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // Offset 1599 starts an emoji, so the 1600-unit cut lands between its two halves; 1399 does the same for the
  // next chunk's start (1400).
  const text = 'a'.repeat(1399) + '😀' + 'b'.repeat(198) + '😀' + 'c'.repeat(800);
  await writeFile(path.join(root, 'emoji.md'), text);
  store.pinDocument(root, 'emoji.md');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const chunks = db
      .prepare("SELECT content FROM knowledge_items WHERE source='emoji.md' ORDER BY id")
      .all()
      .map((row) => String(row.content));
    assert.ok(chunks.length >= 2);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const chunk of chunks) assert.doesNotMatch(chunk, lone);
  } finally {
    db.close();
  }
});

test('a document is cut into as many chunks as it needs and no trailing duplicate', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-chunks-'));
  const store = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // Windows are 1600 units wide and start every 1400: exactly one window used to be followed by a second that
  // only repeated its last 200 units.
  for (const [length, expected] of [
    [1600, 1],
    [1601, 2],
    [3000, 2],
    [3001, 3],
  ] as const) {
    const name = `doc-${length}.md`;
    await writeFile(path.join(root, name), 'x'.repeat(length));
    assert.equal(store.pinDocument(root, name).chunks, expected, `${length} characters`);
  }
});

/** Noon UTC on the given day, so the date a memory records is that day in every time zone a test runs in. */
const day = (date: string) => new Date(`${date}T12:00:00Z`);
const reminderKeys = (summary: string) =>
  summary
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.split(' ')[2]!.replace(/:$/, ''));

test('a memory scores by type, freshness and use, and a pinned one outranks everything', () => {
  const entry = (type: 'feedback' | 'project' | 'reference', pinned = false) => ({
    key: 'k',
    type,
    description: 'd',
    text: 't',
    updatedAt: '2026-01-01',
    revision: '000000000000',
    ...(pinned ? { pinned: true as const } : {}),
  });
  const seen = { firstSeen: '2026-01-01', usedDays: 0 };
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual}`);
  near(memoryScore(entry('feedback'), seen, '2026-10-30'), 3 + 2, 'feedback does not decay');
  near(memoryScore(entry('project'), seen, '2026-01-01'), 1 + 2, 'a fresh project');
  near(memoryScore(entry('project'), seen, '2026-03-02'), 1 + 1, 'a project halves in 60 days');
  near(memoryScore(entry('reference'), seen, '2026-01-31'), 0 + 1, 'a reference halves in 30 days');
  near(
    memoryScore(entry('project'), undefined, '2026-10-30'),
    1 + 2,
    'unrecorded counts as seen today',
  );
  near(
    memoryScore(entry('project'), { ...seen, lastUsed: '2026-10-30', usedDays: 7 }, '2026-10-30'),
    1 + 2 + 1,
    'a use renews freshness and adds heat',
  );
  near(
    memoryScore(entry('project'), { ...seen, lastUsed: '2026-10-30', usedDays: 1e6 }, '2026-10-30'),
    1 + 2 + memoryScoring.heatCap,
    'heat is capped',
  );
  assert.ok(memoryScore(entry('reference', true), seen, '2030-01-01') >= memoryScoring.pinned);
});

test('pinned memories round-trip, survive a replace and lead the reminder', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  const saved = await saveMemoryEntry(workspace, 'always', 'Never push to main.', {
    type: 'reference',
    description: 'Never push to main',
    pinned: true,
    now: day('2025-01-01'),
  });
  await saveMemoryEntry(workspace, 'fresh', 'Fresh feedback', {
    type: 'feedback',
    description: 'Fresh',
  });
  const file = await readFile(memoryFile(workspace, 'always'), 'utf8');
  assert.match(file, /^pinned: true$/m);
  assert.equal(parseMemoryEntry('always', Buffer.from(file)).entry.pinned, true);
  const replaced = await saveMemoryEntry(workspace, 'always', 'Never push to main or release.', {
    type: 'reference',
    revision: saved.revision,
  });
  assert.equal(replaced.pinned, true, 'a replace that does not mention pinned keeps it');
  assert.equal(reminderKeys(memorySummary(root, globalDir))[0], 'always');
  const unpinned = await saveMemoryEntry(workspace, 'always', 'Never push.', {
    type: 'reference',
    revision: replaced.revision,
    pinned: false,
  });
  assert.equal(unpinned.pinned, undefined);
  assert.doesNotMatch(await readFile(memoryFile(workspace, 'always'), 'utf8'), /pinned/);
  await assert.rejects(saveMemoryEntry(workspace, 'other', 'x', { pinned: 'yes' }), /pinned/);
});

test('a long-unused reference is left out of the reminder but stays listed and searchable', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  await saveMemoryEntry(workspace, 'old-link', 'https://example.test/old', {
    type: 'reference',
    description: 'Old runbook link',
    now: day('2026-01-01'),
  });
  await saveMemoryEntry(workspace, 'new-link', 'https://example.test/new', {
    type: 'reference',
    description: 'New runbook link',
    now: day('2026-06-01'),
  });
  const summary = memorySummary(root, globalDir, day('2026-06-01'));
  assert.deepEqual(reminderKeys(summary), ['new-link']);
  assert.match(summary, /\(1 further memories not listed; list_memories shows them all\)/);
  assert.equal(listMemoryEntries(root, globalDir).workspace.length, 2);
  assert.deepEqual(
    recallMemories(root, 'runbook link', globalDir)
      .map((hit) => hit.key)
      .sort(),
    ['new-link', 'old-link'],
  );
});

test('the reminder keeps its order through a day of reads and re-ranks when the day turns', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  const first = day('2026-06-01');
  for (const key of ['alpha', 'beta'])
    await saveMemoryEntry(workspace, key, `${key} decision`, {
      type: 'project',
      description: key,
      now: first,
    });
  const before = memorySummary(root, globalDir, first);
  assert.deepEqual(reminderKeys(before), ['alpha', 'beta']);
  await recordMemoryUse(workspace, ['beta'], first);
  assert.equal(
    memorySummary(root, globalDir, first),
    before,
    'a read does not re-announce the index',
  );
  assert.deepEqual(reminderKeys(memorySummary(root, globalDir, day('2026-06-02'))), [
    'beta',
    'alpha',
  ]);
});

test('near the limit the reminder names the lowest-ranked memories, and a full directory says which to drop', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  const now = day('2026-06-01');
  await saveMemoryEntry(workspace, 'stale-ref', 'old', {
    type: 'reference',
    description: 'Stale',
    now: day('2026-01-01'),
  });
  for (let index = 1; index < memoryScoring.nearLimit; index++)
    await saveMemoryEntry(workspace, `entry-${index}`, `entry ${index}`, { now });
  assert.match(
    memorySummary(root, globalDir, now),
    new RegExp(
      `Workspace memory holds ${memoryScoring.nearLimit} of ${memoryLimits.entries} entries\\. Lowest-ranked: stale-ref, `,
    ),
  );
  for (let index = memoryScoring.nearLimit; index < memoryLimits.entries; index++)
    await saveMemoryEntry(workspace, `entry-${index}`, `entry ${index}`, { now });
  await assert.rejects(
    saveMemoryEntry(workspace, 'one-more', 'x', { now }),
    /Memory limit reached \(64\).*Lowest-ranked: stale-ref/,
  );
});

test('the daily clean-up archives project and reference memories unused for 90 days, and restore brings one back', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  const start = day('2026-01-01');
  await saveMemoryEntry(workspace, 'old-project', 'old project', { type: 'project', now: start });
  await saveMemoryEntry(workspace, 'old-link', 'old link', { type: 'reference', now: start });
  await saveMemoryEntry(workspace, 'old-feedback', 'old feedback', {
    type: 'feedback',
    now: start,
  });
  await saveMemoryEntry(workspace, 'pinned-project', 'pinned', {
    type: 'project',
    pinned: true,
    now: start,
  });
  await saveMemoryEntry(workspace, 'recent', 'recent', { type: 'project', now: day('2026-03-01') });
  const before = readMemoryEntry(workspace, 'old-project');
  const later = day('2026-04-10');
  await maintainMemories(root, globalDir, later);
  assert.deepEqual(
    listMemoryEntries(root, globalDir).workspace.map((entry) => entry.key),
    ['old-feedback', 'pinned-project', 'recent'],
    'feedback, pinned and recently written memories stay',
  );
  assert.deepEqual(
    readArchivedEntries(workspace).map((entry) => entry.key),
    ['old-link', 'old-project'],
  );
  assert.ok(existsSync(path.join(memoryArchiveDir(workspace), 'old-project.md')));
  assert.equal(
    readMemoryEntry(workspace, 'old-project', { archived: true }).revision,
    before.revision,
    'moved byte for byte',
  );
  const summary = memorySummary(root, globalDir, later);
  assert.match(
    summary,
    /Workspace memories archived today \(unused for 90\+ days\): old-link, old-project\. restore_memory brings one back\./,
  );
  assert.doesNotMatch(summary, / old-project:/);
  assert.doesNotMatch(
    memorySummary(root, globalDir, day('2026-04-11')),
    /archived today/,
    'the notice lasts the day',
  );
  const restored = await restoreMemoryEntry(workspace, 'old-project', later);
  assert.equal(restored.revision, before.revision);
  assert.equal(memoryUsage(workspace)['old-project']?.lastUsed, '2026-04-10');
  await maintainMemories(root, globalDir, day('2026-04-11'));
  assert.ok(
    listMemoryEntries(root, globalDir).workspace.some((entry) => entry.key === 'old-project'),
    'a restored memory is not archived again the next day',
  );
  await assert.rejects(restoreMemoryEntry(workspace, 'old-project'), /No archived memory/);
});

test('a memory older than the usage record gets a grace period, and nothing is archived where memories are read-only', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  await mkdir(workspace.dir, { recursive: true });
  await writeFile(
    memoryFile(workspace, 'legacy'),
    renderMemoryEntry({
      key: 'legacy',
      type: 'project',
      description: 'Legacy',
      text: 'Legacy decision',
      updatedAt: '2025-01-01',
    }),
  );
  await maintainMemories(root, globalDir, day('2026-06-01'));
  assert.equal(memoryUsage(workspace).legacy?.firstSeen, '2026-06-01');
  assert.deepEqual(readArchivedEntries(workspace), [], 'its grace period starts today');
  // An archived copy and a live memory with the same key: restoring would overwrite, so it is refused.
  await mkdir(memoryArchiveDir(workspace), { recursive: true });
  await writeFile(path.join(memoryArchiveDir(workspace), 'legacy.md'), 'Archived copy');
  await assert.rejects(restoreMemoryEntry(workspace, 'legacy'), /already exists/);
  await rm(path.join(memoryArchiveDir(workspace), 'legacy.md'));
  withSetting(t, 'YUANTU_MEMORY', 'read');
  await recordMemoriesSeen(workspace, day('2026-12-01'));
  await maintainMemories(root, globalDir, day('2026-12-01'));
  assert.deepEqual(readArchivedEntries(workspace), [], 'a read-only deployment moves nothing');
});

test('memory tools list, read, recall, forget and restore archived memories, flag likely duplicates and set pinned', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-archive-tools-');
  await saveMemoryEntry(workspace, 'old-plan', 'Ship the beta in March, marker 962', {
    type: 'project',
    description: 'Beta plan',
    now: day('2026-01-01'),
  });
  await saveMemoryEntry(workspace, 'old-notes', 'Old notes, marker 963', {
    type: 'project',
    description: 'Old notes',
    now: day('2026-01-01'),
  });
  await maintainMemories(root, undefined, day('2026-06-01'));
  const registry = memoryToolRegistry(root);
  const run = async (name: string, args: Record<string, unknown>) => {
    const outcome = await registry.execute({ id: name, name, arguments: args }, readContext());
    assert.equal(outcome.isError, false, outcome.content);
    return JSON.parse(outcome.content);
  };
  const listed = await run('list_memories', { include_archived: true });
  assert.deepEqual(listed.memories.workspace, []);
  assert.deepEqual(
    listed.archived.workspace.map((entry: { key: string }) => entry.key),
    ['old-notes', 'old-plan'],
  );
  assert.equal((await run('list_memories', {})).archived, undefined);
  assert.deepEqual(
    (await run('recall_knowledge', { query: 'marker 962' })).results,
    [],
    'archived memories are not recalled unless asked for',
  );
  const [archivedHit] = (
    await run('recall_knowledge', { query: 'marker 962', include_archived: true })
  ).results;
  assert.equal(archivedHit.archived, true);
  assert.equal(archivedHit.source, '.yuantu/memory/_archive/old-plan.md');
  const read = await run('read_memory', { scope: 'workspace', key: 'old-plan', archived: true });
  assert.equal(read.archived, true);
  assert.match(read.text, /marker 962/);
  await run('restore_memory', { scope: 'workspace', key: 'old-plan' });
  assert.deepEqual(
    (await run('list_memories', {})).memories.workspace.map((entry: { key: string }) => entry.key),
    ['old-plan'],
  );
  const notes = readArchivedEntries(workspace).find((entry) => entry.key === 'old-notes')!;
  await run('forget_memory', {
    scope: 'workspace',
    key: 'old-notes',
    revision: notes.revision,
    archived: true,
  });
  assert.deepEqual(readArchivedEntries(workspace), []);
  const similar = await run('save_memory', {
    scope: 'workspace',
    key: 'beta-plan-v2',
    type: 'project',
    description: 'Beta plan v2',
    content: 'Ship the beta in April.',
  });
  assert.deepEqual(
    similar.similar.map((entry: { key: string }) => entry.key),
    ['old-plan'],
  );
  const pinned = await run('save_memory', {
    scope: 'workspace',
    key: 'no-force-push',
    type: 'feedback',
    description: 'Never force-push shared branches',
    content: 'Never force-push shared branches.',
    pinned: true,
  });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.similar, undefined);
  assert.equal(
    (await run('list_memories', {})).memories.workspace.find(
      (entry: { key: string }) => entry.key === 'no-force-push',
    ).pinned,
    true,
  );
  await registry.close();
  withSetting(t, 'YUANTU_MEMORY', 'read');
  const readOnly = memoryToolRegistry(root);
  assert.ok(!readOnly.specs().some((spec) => spec.name === 'restore_memory'));
  await readOnly.close();
});

test('between two equally relevant memories, recall puts the higher-scoring one first, but never above a clearly better match', async (t) => {
  const { root, globalDir, workspace } = await fixture(t);
  for (const key of ['alpha', 'beta'])
    await saveMemoryEntry(workspace, key, 'Run the deploy checklist before tagging.', {
      type: 'project',
      description: `Deploy checklist ${key}`,
    });
  const order = () => recallMemories(root, 'deploy checklist', globalDir).map((hit) => hit.key);
  assert.deepEqual(order(), ['alpha', 'beta'], 'a tie falls back to the key');
  await recordMemoryUse(workspace, ['beta']);
  assert.deepEqual(order(), ['beta', 'alpha'], 'a use lifts the memory that was needed');
  // A pinned memory scores far higher, but the boost is capped, so a much better match still wins.
  await saveMemoryEntry(workspace, 'pinned-note', `deploy ${'unrelated words '.repeat(60)}`, {
    type: 'reference',
    description: 'Misc',
    pinned: true,
  });
  await saveMemoryEntry(workspace, 'exact', 'deploy checklist deploy checklist', {
    type: 'reference',
    // Neither description names the query, so the order below is bm25 and the boost, not the description rule.
    description: 'The full list',
  });
  const deploy = recallMemories(root, 'deploy', globalDir, { limit: 20 }).map((hit) => hit.key);
  assert.ok(deploy.indexOf('exact') < deploy.indexOf('pinned-note'), JSON.stringify(deploy));
});

test('saving a memory that was archived before reports the archived one as similar', async (t) => {
  const { root, workspace } = await memoryFixture(t, 'yuantu-memory-similar-archived-');
  await saveMemoryEntry(workspace, 'release-notes', 'Notes live in docs/releases.', {
    type: 'reference',
    description: 'Where the release notes live',
    now: day('2026-01-01'),
  });
  await maintainMemories(root, undefined, day('2026-06-01'));
  assert.deepEqual(
    readArchivedEntries(workspace).map((entry) => entry.key),
    ['release-notes'],
  );
  const registry = memoryToolRegistry(root);
  const saved = await registry.execute(
    {
      id: 'save',
      name: 'save_memory',
      arguments: {
        scope: 'workspace',
        key: 'release-notes',
        type: 'reference',
        description: 'Where the release notes live now',
        content: 'Notes live in docs/release-notes.',
      },
    },
    readContext(),
  );
  assert.equal(saved.isError, false, saved.content);
  assert.deepEqual(JSON.parse(saved.content).similar, [
    {
      key: 'release-notes',
      description: 'Where the release notes live',
      revision: readArchivedEntries(workspace)[0]!.revision,
      archived: true,
    },
  ]);
  await registry.close();
});
