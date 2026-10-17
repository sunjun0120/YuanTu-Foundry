import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../packages/knowledge/store.ts';
import { realpathSync, writeFileSync } from 'node:fs';
import { riskWorker } from './risk-concurrency.ts';
import { knowledgeTools } from '../packages/knowledge/tools.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { memoryContext } from '../packages/knowledge/context.ts';
import {
  memoryPaths,
  forgetMemoryEntry,
  listMemoryEntries,
  memoryLimits,
  memorySummary,
  parseMemory,
  renderMemory,
  saveMemoryEntry,
  searchMemories,
} from '../packages/knowledge/memory.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { Message, ModelRequest } from '../packages/protocol/index.ts';

test('concurrent pins competing for the last document slot preserve the quota and whole indexes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-knowledge-quota-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-doc-rank-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-index-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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

  // Shrinking it again makes the next refresh pick the new content up.
  await writeFile(doc, '现在使用 pnpm build 构建。');
  assert.equal(store.search(root, 'pnpm build')[0]?.source, 'guide.md');

  // A genuinely removed source file is the one case that drops the entry.
  await rm(doc);
  assert.deepEqual(store.search(root, 'pnpm build'), []);
  assert.deepEqual(store.listDocuments(root), []);
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
  assert.match(recall.content, /\.yuantu\/memory\.md/, 'the result names its source file');
  const save = {
    id: 'write',
    name: 'save_memory',
    arguments: { scope: 'workspace', key: 'no-auto-save', content: 'Must ask first' },
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
  assert.equal(memoryContext(root, globalDir), '');
  const { saveMemoryEntry } = await import('../packages/knowledge/memory.ts');
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  await saveMemoryEntry(workspace, 'build', 'Use the local build 348');
  const prompt = memoryContext(root, globalDir);
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
    registry.execute({ id, name, arguments: args }, { signal, approve: async () => allow });

  const created = await run(
    '1',
    'save_memory',
    { scope: 'workspace', key: 'build-preference', content: 'Use npm run build' },
    true,
  );
  assert.equal(created.isError, false);
  assert.equal(JSON.parse(created.content).key, 'build-preference');
  const listed = await run('2', 'list_memories', {}, false);
  assert.equal(JSON.parse(listed.content).memories.workspace[0].key, 'build-preference');
  const denied = await run(
    '3',
    'save_memory',
    { scope: 'workspace', key: 'build-preference', content: 'Use npm run check' },
    false,
  );
  assert.equal(denied.isError, true);
  const replaced = await run(
    '4',
    'save_memory',
    { scope: 'workspace', key: 'build-preference', content: 'Use npm run check' },
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
    { scope: 'workspace', key: 'build-preference' },
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

test('memory is readable markdown and entries round-trip through it', async (t) => {
  const { workspace } = await fixture(t);
  await saveMemoryEntry(workspace, 'windows-shell', 'Use npm.cmd in this repository.');
  const text = await readFile(workspace, 'utf8');
  assert.match(text, /^# YuanTu memory/m);
  assert.match(
    text,
    /^- \*\*windows-shell\*\*: Use npm\.cmd in this repository\. \(\d{4}-\d{2}-\d{2}\)$/m,
  );
  const memory = parseMemory(text);
  assert.deepEqual(
    memory.entries.map((entry) => entry.key),
    ['windows-shell'],
  );
  assert.equal(renderMemory(memory), text, 'a parsed file renders back to itself');
});

test('hand-written markdown outside the managed bullets survives every write', async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(path.dirname(workspace), { recursive: true });
  await writeFile(
    workspace,
    '# YuanTu memory\n\nMy own notes: the staging database is read-only.\n\n- **old**: keep me (2026-01-02)\n',
  );
  await saveMemoryEntry(workspace, 'new', 'Added later.');
  const afterSave = await readFile(workspace, 'utf8');
  assert.match(afterSave, /My own notes: the staging database is read-only\./);
  await forgetMemoryEntry(workspace, 'old');
  const afterForget = await readFile(workspace, 'utf8');
  assert.match(afterForget, /My own notes: the staging database is read-only\./);
  assert.match(afterForget, /\*\*new\*\*/);
  assert.doesNotMatch(afterForget, /\*\*old\*\*/);
});

test('saving an existing key replaces its text in place and re-dates it', async (t) => {
  const { workspace } = await fixture(t);
  await saveMemoryEntry(workspace, 'build', 'Use npm run build', new Date('2026-01-01T00:00:00Z'));
  await saveMemoryEntry(workspace, 'other', 'Unrelated', new Date('2026-01-01T00:00:00Z'));
  const replaced = await saveMemoryEntry(
    workspace,
    'build',
    'Use npm run check',
    new Date('2026-03-04T00:00:00Z'),
  );
  assert.equal(replaced.updatedAt, '2026-03-04');
  const memory = parseMemory(await readFile(workspace, 'utf8'));
  assert.deepEqual(
    memory.entries.map((entry) => entry.key),
    ['build', 'other'],
    'replacing keeps the original position',
  );
  assert.equal(memory.entries[0]!.text, 'Use npm run check');
});

test('keys and content are validated instead of written blindly', async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(() => saveMemoryEntry(workspace, 'Not A Key', 'x'), /Invalid memory key/);
  await assert.rejects(() => saveMemoryEntry(workspace, '', 'x'), /Invalid memory key/);
  await assert.rejects(() => saveMemoryEntry(workspace, 'ok', '   '), /must not be empty/);
  await assert.rejects(
    () => saveMemoryEntry(workspace, 'ok', 'x'.repeat(memoryLimits.text + 1)),
    /exceeds/,
  );
  await assert.rejects(() => forgetMemoryEntry(workspace, 'missing'), /No memory named/);
  const normalized = await saveMemoryEntry(workspace, 'multiline', 'first\n\n  second  ');
  assert.equal(normalized.text, 'first second', 'entries stay on one readable line');
});

test('the entry count is bounded so the file cannot grow without limit', async (t) => {
  const { workspace } = await fixture(t);
  for (let index = 0; index < memoryLimits.entries; index++)
    await saveMemoryEntry(workspace, `entry-${index}`, `value ${index}`);
  await assert.rejects(() => saveMemoryEntry(workspace, 'one-too-many', 'x'), /limit reached/);
  await forgetMemoryEntry(workspace, 'entry-0');
  assert.equal((await saveMemoryEntry(workspace, 'one-too-many', 'x')).key, 'one-too-many');
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

test('the reminder is bounded even when the file holds more entries', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  for (let index = 0; index <= memoryLimits.injectedEntries; index++)
    await saveMemoryEntry(workspace, `extra-${index}`, `filler ${index}`);
  const summary = memorySummary(root, globalDir);
  assert.match(summary, /further entries omitted/);
  assert.doesNotMatch(summary, /Respond in Chinese/, 'the budget stops before the global file');
  const listed = listMemoryEntries(root, globalDir);
  assert.equal(listed.workspace.length, memoryLimits.injectedEntries + 1);
  assert.equal(listed.global.length, 1, 'the reminder is bounded, the file is not truncated');
});

test('recall matches memory text case-insensitively across both scopes', async (t) => {
  const { root, globalDir, workspace, global } = await fixture(t);
  await saveMemoryEntry(global, 'language', 'Respond in Chinese');
  await saveMemoryEntry(workspace, 'release', 'Use staged rollout 481');
  assert.deepEqual(
    searchMemories(root, 'STAGED', globalDir).map((entry) => [entry.scope, entry.key]),
    [['workspace', 'release']],
  );
  assert.deepEqual(
    searchMemories(root, 'chinese', globalDir).map((entry) => entry.scope),
    ['global'],
  );
  assert.deepEqual(searchMemories(root, '   ', globalDir), []);
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
