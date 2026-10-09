import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../protocol/index.ts';
import type { SessionEventType } from './events.ts';
import { deadOwner } from './session-schema.ts';
/**
 * The stream-checkpoint group: durable recovery points for a run that is still being written.
 *
 * A long answer is persisted as it arrives, not when it finishes, so a crash mid-stream leaves something a reader
 * can show and a recovery pass can settle. This module owns the four writes that make that true and the pass that
 * converges what a dead process left behind:
 *
 * - **A checkpoint belongs to a live run.** `checkpointStream` inserts by selecting the run row, so a checkpoint
 *   for a run that is no longer `running` cannot be written at all — the refusal is the SQL, not a check before it.
 * - **A folded input is one fact in two halves.** `consumeQueuedInput` writes the message and the inbox receipt in
 *   one transaction, in that order: the other order would let a crash leave an inbox entry pointing at a message the
 *   model has already seen, and a client would offer to send it twice.
 * - **Recovery only converges streams whose owner is gone.** A live Host keeps writing its own rows.
 *
 * The store is borrowed through a four-member port — the connection, the transaction wrapper, and the two things
 * that must go through the same log (`append`, `recordEvent`) — because a checkpoint that bypassed the log would
 * be a durable fact the fold cannot see.
 */
export interface StreamCheckpointPort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  append(id: string, message: Message): void;
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ): void;
}

/** The consumer of this session's stream rows; every method forwards to it (see `./session-streams.ts`). */
export class StreamCheckpoints {
  private readonly port: StreamCheckpointPort;

  constructor(port: StreamCheckpointPort) {
    this.port = port;
  }

  checkpointStream(id: string, runId: string, messageId: string, text: string): void {
    if (!text) return;
    const saved = this.port.db
      .prepare(
        `INSERT INTO run_stream_checkpoints(run_id,session_id,message_id,text,updated_at)
           SELECT id,session_id,?,?,? FROM runs WHERE id=? AND session_id=? AND status='running'
           ON CONFLICT(run_id,message_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`,
      )
      .run(messageId, text, new Date().toISOString(), runId, id);
    if (saved.changes !== 1) throw new Error('Cannot checkpoint an inactive stream');
  }
  /**
   * Fold one queued input into the transcript, and record that it was consumed by *that* message.
   *
   * One transaction rather than two calls at the call site, because the two halves are one fact: the inbox
   * entry is settled exactly when a user message exists for it. Written the other way round — append, then
   * record — a crash in between would leave an inbox entry pointing at a message the model has already seen,
   * and a client would offer to send it twice; written this way round, a crash leaves neither.
   */
  consumeQueuedInput(id: string, inputId: string, message: Message): void {
    this.port.transaction(() => {
      this.port.append(id, message);
      this.port.recordEvent(id, 'input.consumed', { id: inputId });
    });
  }
  /** Commit the final assistant message and remove its recovery point atomically. */
  appendStreamMessage(id: string, runId: string, messageId: string, message: Message): void {
    this.port.transaction(() => {
      this.port.append(id, message);
      this.port.db
        .prepare('DELETE FROM run_stream_checkpoints WHERE run_id=? AND message_id=?')
        .run(runId, messageId);
    });
  }
  /** Preserve an unfinished response once, without ever replaying incomplete tool calls. */
  persistStreamCheckpoint(id: string, runId: string): string {
    return this.port.transaction(() => {
      const rows = this.port.db
        .prepare(
          'SELECT message_id AS messageId,text FROM run_stream_checkpoints WHERE session_id=? AND run_id=? ORDER BY updated_at,message_id',
        )
        .all(id, runId);
      let last = '';
      for (const row of rows) {
        const partial = String(row.text);
        if (partial) {
          this.port.append(id, {
            role: 'assistant',
            content: partial,
            toolCalls: [],
            interrupted: true,
          });
          last = partial;
        }
      }
      this.port.db
        .prepare('DELETE FROM run_stream_checkpoints WHERE session_id=? AND run_id=?')
        .run(id, runId);
      return last;
    });
  }
  /** Reconcile only streams whose owning process is gone; active Hosts keep writing their own rows. */
  recoverInterruptedStreams(workspace?: string): number {
    return this.port.transaction(() => {
      const rows = this.port.db
        .prepare(
          `SELECT DISTINCT c.run_id AS runId,c.session_id AS sessionId,r.owner_pid AS ownerPid
             FROM run_stream_checkpoints c JOIN runs r ON r.id=c.run_id
             JOIN sessions s ON s.id=c.session_id
             WHERE (? IS NULL OR s.workspace=?)`,
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid));
      for (const row of rows)
        this.persistStreamCheckpoint(String(row.sessionId), String(row.runId));
      return rows.length;
    });
  }
}
