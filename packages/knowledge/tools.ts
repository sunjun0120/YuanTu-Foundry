import type { Tool } from '../protocol/index.ts';
import { KnowledgeStore } from './store.ts';
import {
  forgetMemoryEntry,
  listMemoryEntries,
  memoryPaths,
  saveMemoryEntry,
  searchMemories,
} from './memory.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

export function knowledgeTools(root: string): { tools: Tool[]; close: () => Promise<void> } {
  let store: KnowledgeStore | undefined;
  const get = () => (store ??= new KnowledgeStore());
  const result = (value: unknown) => ({ isError: false, content: JSON.stringify(value) });
  const scopePath = (scope: unknown) => {
    if (scope !== 'global' && scope !== 'workspace') throw new Error('Invalid memory scope');
    return memoryPaths(root)[scope];
  };
  const memoryFields = {
    scope: { type: 'string', enum: ['global', 'workspace'] },
    key: { type: 'string', minLength: 1, maxLength: 64 },
    content: { type: 'string', minLength: 1, maxLength: 500 },
  };
  return {
    tools: [
      {
        name: 'recall_knowledge',
        isConcurrencySafe: parallelRead,
        description:
          'Search durable memories and indexed project documents. Use when earlier user preferences, decisions, or project documentation may matter. Results include sources. If no result is found, do not invent one.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const query = String(args.query);
          const indexed = get()
            .search(root, query)
            .map((item) => ({
              kind: item.kind,
              scope: item.scope,
              title: item.title,
              content: item.content,
              source: item.source,
            }));
          const memories = searchMemories(root, query).map((entry) => ({
            kind: 'memory' as const,
            scope: entry.scope,
            title: entry.key,
            content: entry.text,
            source: entry.scope === 'global' ? '~/.yuantu/memory.md' : '.yuantu/memory.md',
          }));
          return result([...memories, ...indexed]);
        },
      },
      {
        name: 'list_memories',
        isConcurrencySafe: parallelRead,
        description:
          'List the markdown memories for the current workspace and the user, plus indexed project documents. Use before replacing or forgetting an entry.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () =>
          result({ memories: listMemoryEntries(root), documents: get().listDocuments(root) }),
      },
      {
        name: 'save_memory',
        description:
          'Create or replace one durable memory for future sessions, when it is useful beyond this conversation. The key is a short stable name; saving an existing key replaces its text. Prefer workspace scope; use global only for user-wide preferences. Avoid transient task details, guesses and secrets. Memories are stored in a markdown file the user can edit. This persistent write requires approval.',
        permission: 'write',
        inputSchema: {
          type: 'object',
          properties: memoryFields,
          required: ['scope', 'key', 'content'],
          additionalProperties: false,
        },
        execute: async (args) =>
          result(await saveMemoryEntry(scopePath(args.scope), args.key, args.content)),
      },
      {
        name: 'forget_memory',
        description:
          'Delete one saved memory at the user request or when it is clearly obsolete, after listing its key. This persistent deletion requires approval.',
        permission: 'write',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['global', 'workspace'] },
            key: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: ['scope', 'key'],
          additionalProperties: false,
        },
        execute: async (args) => {
          await forgetMemoryEntry(scopePath(args.scope), args.key);
          return result({ deleted: true });
        },
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
    ],
    close: async () => {
      store?.close();
      store = undefined;
    },
  };
}
