import type { FileChange, Message } from '../../packages/protocol/index.ts';
import type { StoredFileChange } from '../../packages/storage/session-schema.ts';
import { isRuntimeContext } from '../../packages/protocol/context.ts';

export interface TurnChangedFile {
  path: string;
  added: number;
  removed: number;
  entries: { record: StoredFileChange; change: FileChange }[];
}
export interface TurnChanges {
  key: string;
  afterIndex: number;
  files: TurnChangedFile[];
}

/** Finished-run boundaries are durable. Legacy tool receipts use only the visible question interval. */
export function collectTurnChanges(
  records: readonly StoredFileChange[],
  messages: readonly Message[],
  startIndex: number,
  running: boolean,
): TurnChanges[] {
  const turns = new Map<string, TurnChanges>();
  const receipts = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'tool' && message.change?.id) receipts.set(message.change.id, index);
  });
  const legacyEnd = (index: number): number | undefined => {
    for (let next = index + 1; next < messages.length; next++) {
      const message = messages[next]!;
      if (message.role === 'user' && !isRuntimeContext(message.content))
        return startIndex + next - 1;
    }
    return running ? undefined : startIndex + messages.length - 1;
  };
  const all = [...records].reverse(); // Journal rows arrive newest first; file order follows the work.
  const known = new Set(records.map((record) => record.id));
  messages.forEach((message, index) => {
    if (
      message.role !== 'tool' ||
      message.isError ||
      !message.change ||
      (message.change.id && known.has(message.change.id))
    )
      return;
    // A modern receipt without its journal row may be a refresh in flight. Do not invent its ownership.
    if (message.change.id) return;
    const id = `legacy:${startIndex + index}`;
    receipts.set(id, index);
    all.push({ id, sessionId: '', createdAt: '', status: 'applied', change: message.change });
  });
  for (const record of all) {
    if (record.status === 'abandoned') continue;
    const receipt = receipts.get(record.id);
    const afterIndex =
      record.endMessageIndex ??
      ((!record.runId || record.runFinished) && receipt !== undefined
        ? legacyEnd(receipt)
        : undefined);
    if (
      afterIndex === undefined ||
      afterIndex < startIndex ||
      afterIndex >= startIndex + messages.length
    )
      continue;
    const key =
      record.runId ??
      [...turns.values()].find((turn) => turn.afterIndex === afterIndex)?.key ??
      `legacy:${afterIndex}`;
    let turn = turns.get(key);
    if (!turn) {
      turn = { key, afterIndex, files: [] };
      turns.set(key, turn);
    }
    turn.afterIndex = Math.max(turn.afterIndex, afterIndex);
    const add = (change: FileChange): void => {
      if (change.changes?.length) {
        for (const child of change.changes) add(child);
        return;
      }
      let file = turn.files.find((item) => item.path === change.path);
      if (!file) {
        file = { path: change.path, added: 0, removed: 0, entries: [] };
        turn.files.push(file);
      }
      file.added += change.added;
      file.removed += change.removed;
      file.entries.push({ record, change });
    };
    add(record.change);
  }
  return [...turns.values()].sort((a, b) => a.afterIndex - b.afterIndex);
}
