import { homedir } from 'node:os';
import path from 'node:path';
import type { Tool } from '../protocol/index.ts';
import { KnowledgeStore } from './store.ts';
import {
  type MemoryUse,
  forgetMemoryEntry,
  listMemoryEntries,
  memoryLimits,
  memoryMode,
  memorySources,
  memoryPaths,
  memoryTypes,
  memoryUsage,
  readArchivedEntries,
  readMemoryEntry,
  recordMemoryUse,
  restoreMemoryEntry,
  saveMemoryEntry,
  MEMORY_ARCHIVE_DIR,
  type MemoryEntry,
} from './memory.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * The name is a promise that the tool never writes, and it is granted per tool rather than per module because
 * only one of the tools here can make it. `list_memories` and `read_memory` read the markdown memory files and
 * the pinned document list; the one thing they write is the date a memory was last used, a best-effort record
 * of this package's own that is written one at a time (`recordMemoryUse`), so two of them at once are safe.
 * `recall_knowledge` cannot: a search refreshes the pinned documents first, and a document whose
 * digest changed is re-indexed in a write transaction. That is this package's own index rather than the user's
 * workspace, so nothing about it needs approval — `index_document` is the tool that pulls a project file into
 * the index and declares a permission for it — but it is still a write, and two of these at once would put two
 * writers on one index. So it makes no promise and stays exclusive.
 *
 * A tool that can write, or that mutates state this run owns (the checklist, a job, the language server
 * session), does not get this name either: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

/**
 * Where a recalled memory lives, as a person would type it: workspace entries relative to the project, user-wide
 * ones under the configured directory (`YUANTU_MEMORY_DIR` or the user state directory), with the home directory
 * shortened to `~`.
 */
function memorySourcePath(
  scope: 'global' | 'workspace',
  dir: string,
  key: string,
  archived = false,
): string {
  const name = archived ? `${MEMORY_ARCHIVE_DIR}/${key}.md` : `${key}.md`;
  if (scope === 'workspace') return `.yuantu/memory/${name}`;
  const file = path.join(dir, name);
  const relative = path.relative(homedir(), file);
  const shown =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? path.join('~', relative)
      : file;
  return shown.split(path.sep).join('/');
}
/** Dice similarity of two short texts' character pairs, ignoring case and spacing: 1 for the same words. */
function pairSimilarity(left: string, right: string): number {
  const pairs = (text: string) => {
    const compact = text.toLowerCase().replace(/\s+/g, '');
    const counts = new Map<string, number>();
    for (let index = 0; index < compact.length - 1; index++) {
      const pair = compact.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const a = pairs(left);
  const b = pairs(right);
  let shared = 0;
  let total = 0;
  for (const [pair, count] of a) {
    shared += Math.min(count, b.get(pair) ?? 0);
    total += count;
  }
  for (const count of b.values()) total += count;
  return total ? (2 * shared) / total : 0;
}
/** A new memory's description this close to an existing one's is reported back as a likely duplicate. */
const DUPLICATE_SIMILARITY = 0.6;

/**
 * `root` is where documents are indexed from; `memoryRoot` is the project whose memories these tools read and
 * write. They differ for a child working in a worktree, which holds the project's files but not its `.yuantu`.
 */
export function knowledgeTools(
  root: string,
  memoryRoot = root,
): { tools: Tool[]; close: () => Promise<void> } {
  let store: KnowledgeStore | undefined;
  const get = () => (store ??= new KnowledgeStore());
  const result = (value: unknown) => ({ isError: false, content: JSON.stringify(value) });
  const scopePath = (scope: unknown) => {
    if (scope !== 'global' && scope !== 'workspace') throw new Error('Invalid memory scope');
    return memoryPaths(memoryRoot)[scope];
  };
  const memoryFields = {
    scope: { type: 'string', enum: ['global', 'workspace'] },
    key: { type: 'string', minLength: 1, maxLength: 64 },
    type: { type: 'string', enum: [...memoryTypes] },
    description: { type: 'string', minLength: 1, maxLength: memoryLimits.description },
    content: { type: 'string', minLength: 1, maxLength: memoryLimits.text },
    revision: { type: 'string', pattern: '^[0-9a-f]{12}$' },
    pinned: { type: 'boolean' },
  };
  const archivedField = { type: 'boolean' };
  /** What a listing shows of one memory: enough to choose it, and the revision to change it, but not its text. */
  const index = (entry: MemoryEntry, usage: Record<string, MemoryUse>) => ({
    key: entry.key,
    type: entry.type,
    description: entry.description,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
    ...(entry.session ? { session: entry.session } : {}),
    ...(entry.pinned ? { pinned: true } : {}),
    ...(usage[entry.key]?.lastUsed ? { lastUsed: usage[entry.key]!.lastUsed } : {}),
  });
  /**
   * `YUANTU_MEMORY`: `read` leaves out the tools that change memories, `off` every tool that only serves them.
   * recall_knowledge and list_memories stay either way, for the indexed documents they also cover.
   */
  const mode = memoryMode();
  const withheld = new Set(
    mode === 'off'
      ? ['read_memory', 'save_memory', 'forget_memory', 'restore_memory']
      : mode === 'read'
        ? ['save_memory', 'forget_memory', 'restore_memory']
        : [],
  );
  const tools: Tool[] = [
    {
      name: 'recall_knowledge',
      description:
        'Search durable memories and indexed project documents. Use when earlier user preferences, decisions, or project documentation may matter. Results are ranked by relevance and capped at limit each for memories and documents; a memory carries an excerpt, so read it with read_memory before relying on details. Filter memories with memory_types or memory_scope when only some kinds can matter; include_archived also searches memories archived after months unused. Results include sources and a freshness block: a pinned document listed as stale could not be re-read, so its indexed content may be older than the file. If no result is found, do not invent one, and say when a source is stale rather than treating it as current.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          memory_types: {
            type: 'array',
            items: { type: 'string', enum: [...memoryTypes] },
            minItems: 1,
            uniqueItems: true,
          },
          memory_scope: memoryFields.scope,
          include_archived: archivedField,
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const query = String(args.query);
        const limit = args.limit === undefined ? 8 : Number(args.limit);
        const store = get();
        const indexed = store.search(root, query, limit).map((item) => ({
          kind: item.kind,
          scope: item.scope,
          title: item.title,
          content: item.content,
          source: item.source,
        }));
        const sources = memorySources(memoryRoot, undefined, {
          includeArchived: args.include_archived === true,
        }).filter(
          (source) =>
            args.memory_scope === undefined || source.location.scope === args.memory_scope,
        );
        const found = store.searchMemories(sources, query, {
          limit,
          ...(Array.isArray(args.memory_types) ? { types: args.memory_types } : {}),
        });
        // Only the best few count as used: a long tail of weak matches says nothing about what was needed.
        const used = found.slice(0, 3).filter((hit) => !hit.archived);
        await Promise.all(
          sources.flatMap((source) =>
            source.archived
              ? []
              : [
                  recordMemoryUse(
                    source.location,
                    used.filter((hit) => hit.scope === source.location.scope).map((hit) => hit.key),
                  ),
                ],
          ),
        );
        const paths = memoryPaths(memoryRoot);
        const memories = found.map((hit) => ({
          kind: 'memory' as const,
          scope: hit.scope,
          title: hit.key,
          type: hit.type,
          description: hit.description,
          updatedAt: hit.updatedAt,
          revision: hit.revision,
          excerpt: hit.excerpt,
          ...(hit.archived ? { archived: true } : {}),
          source: memorySourcePath(hit.scope, paths[hit.scope].dir, hit.key, hit.archived),
        }));
        return result({
          results: [...memories, ...indexed],
          freshness: store.freshness(root),
        });
      },
    },
    {
      name: 'list_memories',
      isConcurrencySafe: parallelRead,
      description:
        'List every memory for the current workspace and the user, without its text, plus indexed project documents. Each memory carries the revision that replacing or forgetting it requires, and lastUsed when it has been read or recalled; read_memory returns the text. include_archived also lists memories archived after months unused, which restore_memory brings back.',
      inputSchema: {
        type: 'object',
        properties: { include_archived: archivedField },
        additionalProperties: false,
      },
      execute: async (args) => {
        const listed = listMemoryEntries(memoryRoot);
        const paths = memoryPaths(memoryRoot);
        const used = { workspace: memoryUsage(paths.workspace), global: memoryUsage(paths.global) };
        return result({
          memories: {
            workspace: listed.workspace.map((entry) => index(entry, used.workspace)),
            global: listed.global.map((entry) => index(entry, used.global)),
          },
          ...(args.include_archived === true
            ? {
                archived: {
                  workspace: readArchivedEntries(paths.workspace).map((entry) => index(entry, {})),
                  global: readArchivedEntries(paths.global).map((entry) => index(entry, {})),
                },
              }
            : {}),
          documents: get().listDocuments(root),
        });
      },
    },
    {
      name: 'read_memory',
      isConcurrencySafe: parallelRead,
      description:
        'Read one saved memory in full: its text, type, description, date, the session that wrote it, and the revision that replacing or forgetting it requires. Pass archived to read one from the archive.',
      inputSchema: {
        type: 'object',
        properties: { scope: memoryFields.scope, key: memoryFields.key, archived: archivedField },
        required: ['scope', 'key'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const location = scopePath(args.scope);
        const archived = args.archived === true;
        const entry = readMemoryEntry(location, args.key, { archived });
        if (!archived) await recordMemoryUse(location, [entry.key]);
        return result(archived ? { ...entry, archived: true } : entry);
      },
    },
    {
      name: 'save_memory',
      description:
        'Create or update one durable memory for future sessions. Save only what stays true beyond this conversation: who the user is and how they want you to work (user, feedback), project decisions the code and git history do not record (project), and pointers to external resources (reference). Never save task progress, guesses, secrets, code structure, past fixes, or anything the repository already records. If an entry already covers this, update it with its revision instead of adding another; a missing or outdated revision is refused with the current text to merge. Follow feedback and project facts with "Why:" and "How to apply:" lines. Write absolute dates, never "today". The description is the line later sessions see first, so make it stand alone. Prefer workspace scope; global is for user-wide preferences. Set pinned only when the user wants a memory to always apply; it is always listed and never archived. A new memory worded like an existing or archived one is still saved, with those listed under similar: read them, and only if they record the same thing keep one (merge and forget the other, or restore_memory the archived one). Memories that merely share a pattern, like Q1 and Q2 plans, are distinct. This persistent write requires approval.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: memoryFields,
        required: ['scope', 'key', 'type', 'description', 'content'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const location = scopePath(args.scope);
        const saved = await saveMemoryEntry(location, args.key, args.content, {
          type: args.type,
          description: args.description,
          revision: args.revision,
          pinned: args.pinned,
          ...(context.sessionId ? { session: context.sessionId } : {}),
        });
        /**
         * Only a new entry can be a near-duplicate; a replace is already the one entry for its subject. Archived
         * entries are compared too, and an archived one with the very same key is included: "remembered once,
         * archived after months unused, saved again" is the commonest duplicate there is.
         */
        const similar =
          args.revision === undefined
            ? [
                ...listMemoryEntries(memoryRoot)
                  [location.scope].filter((entry) => entry.key !== saved.key)
                  .map((entry) => ({ entry, archived: false })),
                ...readArchivedEntries(location).map((entry) => ({ entry, archived: true })),
              ]
                .map((candidate) => ({
                  ...candidate,
                  similarity: pairSimilarity(candidate.entry.description, saved.description),
                }))
                .filter((candidate) => candidate.similarity >= DUPLICATE_SIMILARITY)
                .sort((left, right) => right.similarity - left.similarity)
                .slice(0, 3)
                .map(({ entry, archived }) => ({
                  key: entry.key,
                  description: entry.description,
                  revision: entry.revision,
                  ...(archived ? { archived: true } : {}),
                }))
            : [];
        return result(similar.length ? { ...saved, similar } : saved);
      },
    },
    {
      name: 'forget_memory',
      description:
        'Delete one saved memory at the user request or when it is clearly obsolete, passing the revision list_memories reported for it; an outdated revision is refused with the current text. Pass archived to delete one from the archive. This persistent deletion requires approval.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          scope: memoryFields.scope,
          key: memoryFields.key,
          revision: memoryFields.revision,
          archived: archivedField,
        },
        required: ['scope', 'key', 'revision'],
        additionalProperties: false,
      },
      execute: async (args) => {
        await forgetMemoryEntry(scopePath(args.scope), args.key, args.revision, {
          archived: args.archived === true,
        });
        return result({ deleted: true });
      },
    },
    {
      name: 'restore_memory',
      description:
        'Bring an archived memory back into the saved memories, unchanged, when it matters again. Memories unused for months are archived automatically; list_memories with include_archived shows them. Refused when a memory with the same key exists or the limit is reached. This persistent write requires approval.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: { scope: memoryFields.scope, key: memoryFields.key },
        required: ['scope', 'key'],
        additionalProperties: false,
      },
      execute: async (args) => result(await restoreMemoryEntry(scopePath(args.scope), args.key)),
    },
    {
      name: 'index_document',
      description:
        'Add a workspace-relative UTF-8 text or code document to the persistent knowledge index when it is useful for future retrieval. Do not index secrets or unrelated files. This write requires approval.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 240 } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args) => result(get().pinDocument(root, String(args.path))),
    },
    {
      name: 'remove_indexed_document',
      description:
        'Remove a project document from the knowledge index without deleting the source file. This write requires approval.',
      permission: 'write',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 240 } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args) => {
        get().unpinDocument(root, String(args.path));
        return result({ removed: true });
      },
    },
  ];
  return {
    tools: tools.filter((tool) => !withheld.has(tool.name)),
    close: async () => {
      store?.close();
      store = undefined;
    },
  };
}
