import type { Message } from '../protocol/index.ts';
import { RUNTIME_CONTEXT_TAG } from '../protocol/context.ts';

/**
 * Context the conversation carries rather than the prompt: the workspace outline and saved memory.
 *
 * Both are snapshots of state that lives outside the session — the tree, the memory files — and both used to be
 * sections of the system prompt. Undoing that placement is what this module is for, and the reason is the prompt
 * cache: a provider caches a byte-exact prefix, the system prompt is the head of it, so a section that changes
 * invalidates every token behind it — the tool catalogue and the whole conversation, everything the previous
 * round had already paid for. The outline changes whenever a file does, which in a coding session is the normal
 * case rather than the exception, so as a section it made the cache miss between runs as a matter of course.
 *
 * Appended to the conversation instead, the same text costs its own bytes and leaves the prefix intact.
 * Announcements of one source are **last-wins** — the newest says what is true and the older ones read as what
 * was true — and one is appended only when it differs from the newest announcement the transcript already holds,
 * so a round that changed nothing sends a prefix byte-identical to the one before it.
 *
 * The comparison is against what the conversation *shows the model* rather than against anything remembered in
 * this process, and that is what makes three cases behave the same way: a resumed session compares against the
 * snapshot its log holds, a second process starts from the same reading, and a snapshot a compaction covered is
 * no longer part of the window the model sees, so the next round announces it again. Callers pass that window —
 * the transcript after the last compaction — not the whole log.
 */

/**
 * The sources, closed on purpose: a snapshot is read back *by source*, so two features cannot share one without
 * reading each other's text as their own.
 */
export const RUNTIME_SNAPSHOT_SOURCES = ['task', 'memory', 'skills', 'workspace-outline'] as const;
export type RuntimeSnapshotSource = (typeof RUNTIME_SNAPSHOT_SOURCES)[number];

const TAG = RUNTIME_CONTEXT_TAG;
const OPEN = (source: RuntimeSnapshotSource) => `<${TAG} source="${source}">\n`;
const CLOSE = `\n</${TAG}>`;
/**
 * What each snapshot says about itself, and the one rule repetition needs.
 *
 * The wrapper is the runtime's rather than the text's — the same reasoning as the compaction summary's — so the
 * model can see at a glance that this is machine-written context and not something the person said. The second
 * half matters because several snapshots of one source can be in a conversation: the last one is the current one.
 */
const PREAMBLE: Record<RuntimeSnapshotSource, string> = {
  task: 'Machine-written snapshot of the approved task, announced when its steps changed. If this conversation holds more than one, the last is the current one.',
  memory:
    'Machine-written snapshot of saved memory, announced when it changed. If this conversation holds more than one, the last is the current one.',
  skills:
    'Machine-written snapshot of the skills this workspace offers, announced when the set changed. If this conversation holds more than one, the last is the current one.',
  'workspace-outline':
    'Machine-written snapshot of the workspace, announced when it changed. If this conversation holds more than one, the last is the current one.',
};
/** The inner text of a snapshot: what is compared, and what the model reads. */
export function runtimeSnapshotText(source: RuntimeSnapshotSource, body: string): string {
  return `${PREAMBLE[source]}\n${body.trim()}`;
}
/** The message a snapshot is announced as. */
export function runtimeSnapshotMessage(source: RuntimeSnapshotSource, body: string): string {
  return `${OPEN(source)}${runtimeSnapshotText(source, body)}${CLOSE}`;
}
/**
 * The inner text of the newest announcement of `source` in the conversation, or `undefined` when there is none.
 *
 * Read from the end because the newest one is the answer to "what does the conversation say about this now", and
 * both markers are required: a snapshot that was quoted by the model, or truncated, is not a snapshot, and
 * treating one as the current state would silently stop announcing the real one.
 */
export function lastRuntimeSnapshot(
  messages: readonly Message[],
  source: RuntimeSnapshotSource,
): string | undefined {
  const open = OPEN(source);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const content = message.content;
    if (!content.startsWith(open)) continue;
    const end = content.lastIndexOf(CLOSE);
    if (end < open.length) continue;
    return content.slice(open.length, end);
  }
  return undefined;
}
