import type { Message } from '../../protocol/index.ts';
import { RUNTIME_CONTEXT_TAG } from '../../protocol/context.ts';

/**
 * Context the conversation carries rather than the prompt: the workspace outline and saved memory.
 * Both change often, so as prompt sections they would invalidate the cached prefix; appended to the
 * conversation they cost only their own bytes.
 *
 * Announcements are last-wins, and one is appended only when it differs from the newest one the
 * model can see. Callers pass the window after the last compaction, so resumed sessions, other
 * processes and compacted-away snapshots all behave alike.
 */

/**
 * The sources, closed on purpose: a snapshot is read back *by source*, so two features cannot share one without
 * reading each other's text as their own.
 */
export const RUNTIME_SNAPSHOT_SOURCES = [
  'task',
  'completion',
  'model',
  'memory',
  'skills',
  'workspace-outline',
] as const;
export type RuntimeSnapshotSource = (typeof RUNTIME_SNAPSHOT_SOURCES)[number];

const TAG = RUNTIME_CONTEXT_TAG;
const OPEN = (source: RuntimeSnapshotSource) => `<${TAG} source="${source}">\n`;
const CLOSE = `\n</${TAG}>`;
/**
 * Each snapshot's preamble: marked as machine-written context, and stating that the last one is
 * current.
 */
const PREAMBLE: Record<RuntimeSnapshotSource, string> = {
  task: 'Machine-written snapshot of the approved task, announced when its steps changed. If this conversation holds more than one, the last is the current one.',
  /**
   * The contract's state, re-announced after a compaction swallowed it. Definition and progress
   * only, never hashes or ids.
   */
  completion:
    'Machine-written snapshot of this run’s completion contract: the objective, the constraints, the criteria and how the work stands against them. If this conversation holds more than one, the last is the current one.',
  model:
    'Machine-written snapshot of the current request’s host-reported model configuration. If this conversation holds more than one, the last is the current one.',
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
 * The inner text of the newest announcement of `source`, or `undefined`. Both markers are required,
 * so a quoted or truncated snapshot does not count.
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
