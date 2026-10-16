import type { DatabaseSync } from 'node:sqlite';
import type { Surface, SurfaceOp } from '../protocol/context.ts';
import { contextBoundaries, surfaceOf } from '../protocol/context.ts';
import type { Message, Usage } from '../protocol/index.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import { type SessionEvent, type SessionEventType } from './events.ts';
import type { Session } from './session-schema.ts';
import { ageSuffix } from './session-schema.ts';

/** Context compaction persistence and surface reconstruction share the store log and lease. */
export interface SessionContextPort {
  db: DatabaseSync;
  get(id: string): Session;
  checkedLog(id: string): readonly SessionEvent[];
  leaseOf(id: string): SessionLease | null;
  messages(id: string): Message[];
  recordEvent(id: string, type: SessionEventType, data: Record<string, unknown>): void;
}

export class SessionContext {
  private readonly port: SessionContextPort;

  constructor(port: SessionContextPort) {
    this.port = port;
  }

  /**
   * The surface a compaction defines: what stands in for the covered messages.
   *
   * The answer comes from the log alone, which is the point: "what is the model shown" used to be a row in
   * `context_checkpoints`, so the log and the table could disagree and only the table was believed. Deriving
   * it here means a session reopened in another process, or read by a tool that never opened the write path,
   * computes the same view the run did.
   */
  contextSurface(id: string): Surface | null {
    this.port.get(id);
    const ops = this.surfaceOps(id);
    return surfaceOf(ops);
  }

  /** Every compaction this session recorded, oldest first: the surface's history, not just its state. */
  surfaceHistory(id: string): SurfaceOp[] {
    this.port.get(id);
    return this.surfaceOps(id);
  }

  private surfaceOps(id: string): SurfaceOp[] {
    // The surface is a state derived from this log, so it answers only from a log this build can interpret — the
    // same rule the projections follow, and for the same reason: an event whose meaning is unknown could have
    // changed it, and a surface that quietly ignored one is a transcript cut in the wrong place.
    this.port.checkedLog(id);
    const rows = this.port.db
      .prepare(
        "SELECT seq,data FROM session_events WHERE session_id=? AND type='context.compacted' ORDER BY seq",
      )
      .all(id);
    return rows.map((row, index) =>
      this.surfaceOp(id, Number(row.seq), index + 1, JSON.parse(String(row.data))),
    );
  }

  /**
   * One recorded op, with its range checked against the transcript it claims to replace.
   *
   * The check is what makes a range worth recording. A count is a claim about position and quietly re-points
   * when the transcript changes under it; a pair of log positions either names the covered records or does
   * not, and the log is append-only, so a mismatch means this op and these messages are not the same
   * conversation. Refusing to derive a surface from that is the same choice the message fold makes for an
   * event it cannot interpret: better to stop than to show a history nobody recorded.
   */
  private surfaceOp(id: string, seq: number, generation: number, data: unknown): SurfaceOp {
    const payload = (data ?? {}) as Record<string, unknown>;
    const coveredMessages = Number(payload.coveredMessages);
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    if (!Number.isSafeInteger(coveredMessages) || coveredMessages < 1 || !summary.trim())
      throw new Error(
        `Session log event context.compacted at seq ${seq} does not describe a surface replacement`,
      );
    const seqs = this.messageSeqs(id, coveredMessages);
    if (seqs.length !== coveredMessages)
      throw new Error(
        `Session log event context.compacted at seq ${seq} covers ${coveredMessages} message(s), ` +
          `but this session only has ${seqs.length}; refusing to derive a surface from it`,
      );
    const startSeq = seqs[0]!;
    const endSeq = seqs[coveredMessages - 1]!;
    const recordedStart = Number(payload.startSeq);
    const recordedEnd = Number(payload.endSeq);
    if (
      Number.isSafeInteger(recordedStart) &&
      Number.isSafeInteger(recordedEnd) &&
      (recordedStart !== startSeq || recordedEnd !== endSeq)
    )
      throw new Error(
        `Session log event context.compacted at seq ${seq} claims to replace ${recordedStart}–${recordedEnd}, ` +
          `but ${coveredMessages} message(s) from seq ${startSeq}–${endSeq} are what it covers; the record and ` +
          'the transcript do not describe the same conversation',
      );
    return {
      generation,
      startSeq,
      endSeq,
      coveredMessages,
      summary,
      ...(payload.usage ? { usage: payload.usage as Usage } : {}),
      ...(Number.isSafeInteger(Number(payload.replacedChars))
        ? { replacedChars: Number(payload.replacedChars) }
        : {}),
      ...(Number.isSafeInteger(Number(payload.surfaceChars))
        ? { surfaceChars: Number(payload.surfaceChars) }
        : {}),
      // The envelope the summary ran under, carried back out for the same reason it is written: a reader of the
      // *surface* asks "what produced this?" as often as a reader of the raw log does, and a field the record
      // declares but the fold drops answers that question with silence.
      ...(typeof payload.protocol === 'string' ? { protocol: payload.protocol } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(Number.isSafeInteger(Number(payload.maxTokens))
        ? { maxTokens: Number(payload.maxTokens) }
        : {}),
      ...(typeof payload.rawOutput === 'string' ? { rawOutput: payload.rawOutput } : {}),
    };
  }

  /** Log positions of this session's message events, oldest first, capped at `limit`. */
  private messageSeqs(id: string, limit: number): number[] {
    return this.port.db
      .prepare(
        "SELECT seq FROM session_events WHERE session_id=? AND type IN ('message.user','message.assistant','message.tool') ORDER BY seq LIMIT ?",
      )
      .all(id, limit)
      .map((row) => Number(row.seq));
  }

  /**
   * Record a compaction: the messages it covers, and what replaces them.
   *
   * `usage` is what the summary request cost. It is a real model call, so the session's statistics fold it
   * in; it is not a run, so no run budget is charged for it. A caller that does not report usage leaves the
   * event exactly as it always was.
   *
   * `replacedChars`/`surfaceChars` are the price of the trade: what the conversation cost before, and what
   * it costs after. A summary that does not make it smaller is refused here rather than applied — compacting
   * a conversation into something larger is not a compaction, and the caller's alternative (keep the
   * history) is always available.
   *
   * `runId` is the write half of the compaction lock (`claimCompaction` is the acquire half): while a session
   * is held by a run, only that run may record a compaction for it. A session with no lease on record has no
   * competing writer to exclude, which is the store-level caller's path (a migration, a repair).
   *
   * `model`/`maxTokens` are the envelope the summary itself ran under: which model answered, and how much output
   * it was allowed. Together with the per-round `context.envelope` — which records the system prompt and the tool
   * catalogue the summary request replayed — they are what makes "this summary was produced like this" a question
   * the log answers, rather than one only the process that asked it could.
   */
  applyCompaction(
    id: string,
    input: {
      coveredMessages: number;
      summary: string;
      usage?: Usage;
      replacedChars?: number;
      cacheKnown?: boolean;
      surfaceChars?: number;
      runId?: string;
      /**
       * Which adapter answered the summary request, and which model, when the caller knows them.
       *
       * Recorded together because a reader reconstructing the summary needs both halves of the route: the model
       * alone does not say which wire protocol produced it, and the protocol alone does not say which model.
       */
      protocol?: string;
      model?: string;
      /** The output budget that summary request was given. */
      maxTokens?: number;
      /** The answer as it arrived, when storing it changed something (see `SurfaceOp.rawOutput`). */
      rawOutput?: string;
    },
  ): void {
    const lease = this.port.leaseOf(id);
    if (lease && lease.runId !== input.runId)
      throw new Error(
        `Another run is writing this session (run ${lease.runId}, pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}); ` +
          'the compaction was not recorded.',
      );
    const history = this.port.messages(id);
    if (
      !Number.isSafeInteger(input.coveredMessages) ||
      input.coveredMessages < 1 ||
      input.coveredMessages > history.length ||
      !contextBoundaries(history).includes(input.coveredMessages) ||
      !input.summary.trim()
    )
      throw new Error('Invalid context checkpoint boundary');
    const seqs = this.messageSeqs(id, input.coveredMessages);
    if (seqs.length !== input.coveredMessages)
      throw new Error(
        `The log has ${seqs.length} message(s); a compaction cannot cover ${input.coveredMessages}`,
      );
    if (
      input.replacedChars !== undefined &&
      input.surfaceChars !== undefined &&
      input.surfaceChars >= input.replacedChars
    )
      throw new Error(
        `Refusing a compaction that would not shrink the conversation: ${input.replacedChars} characters ` +
          `replaced by ${input.surfaceChars}`,
      );
    this.port.recordEvent(id, 'context.compacted', {
      coveredMessages: input.coveredMessages,
      startSeq: seqs[0]!,
      endSeq: seqs[input.coveredMessages - 1]!,
      summary: input.summary,
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.cacheKnown === undefined ? {} : { cacheKnown: input.cacheKnown }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.replacedChars !== undefined && input.surfaceChars !== undefined
        ? { replacedChars: input.replacedChars, surfaceChars: input.surfaceChars }
        : {}),
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
    });
  }
}
