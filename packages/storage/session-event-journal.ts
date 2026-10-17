import type { DatabaseSync } from 'node:sqlite';
import { isImageReference } from '../protocol/images.ts';
import type { Message } from '../protocol/index.ts';
import {
  appendFoldedMessages,
  assertKnownEvents,
  AUDIT_SESSION_EVENTS,
  foldMessages,
  foldPendingInputs,
  messageEventType,
  type PendingSessionInput,
  type SessionEvent,
  type SessionEventType,
} from './events.ts';
import { sessionTitle, storedMessage, type QueuedBlob } from './session-blobs.ts';
import type { Session } from './session-schema.ts';
import {
  APPEND_BATCH_LIMIT,
  frozen,
  LOG_CACHE_BYTES,
  LOG_CACHE_ENTRIES,
  approximateBytes,
  messageSearchText,
} from './session-schema.ts';

/**
 * A transcript this store has already folded, plus what it takes to know the fold is still current.
 *
 * `dataVersion` is SQLite's `PRAGMA data_version` at the moment the fold was taken: SQLite bumps it when
 * *another* connection commits, so comparing it is how a reader notices a writer it does not own — a
 * second agent-host process, or the CLI appending while the desktop has the session open.
 */
interface LogCacheEntry {
  events: SessionEvent[];
  /** The folded transcript, or null while nobody has asked for it: reading the log is not reading it. */
  messages: Message[] | null;
  /**
   * Whether every event in this log is one this build can interpret: `null` until a *derived* answer asks.
   *
   * Kept on the entry because the check is over the whole log and the answer cannot change while the entry is
   * current — the cached log is dropped when another connection commits, exactly as the transcript is. The raw
   * log does not consult it: a reader diagnosing a session written by a newer build still needs to see the events.
   */
  readable: boolean | null;
  dataVersion: number;
  /** `approximateBytes` of the events, kept so the cache can be bounded by size without re-walking them. */
  bytes: number;
}

/** One message waiting to be written, with the parts of it that are cheaper to compute before the write. */
interface QueuedMessage {
  message: Message;
  /** The same message as the row and the log store it: images replaced by their content addresses. */
  stored: unknown;
  /** The row body, serialised when the message is appended so a bad message is refused by its appender. */
  body: string;
  searchText: string;
  /** Bytes this message adds to `attachment_blobs`, written in the same transaction as the row. */
  blobs: readonly QueuedBlob[];
  /** The title a user message gives its session; null for the roles that never set one. */
  title: string | null;
}

export interface SessionEventJournalPort {
  db: DatabaseSync;
  get(id: string): Session;
}

/**
 * Owns the connection's write ordering: buffered messages, transaction nesting, pending events,
 * cached transcript folds and commit observers. They move together so rollback and publication
 * cannot acquire separate owners. Domain collaborators borrow this journal's transaction.
 */
export class SessionEventJournal {
  private readonly port: SessionEventJournalPort;
  constructor(port: SessionEventJournalPort) {
    this.port = port;
  }

  cachedSessionIds(): string[] {
    return [...this.logCache.keys()];
  }
  dropLogCache(id: string): void {
    this.logCache.delete(id);
  }
  dropPendingAppends(id: string): void {
    this.pendingAppends.delete(id);
  }
  clearObservers(): void {
    this.eventObservers.clear();
  }
  clear(): void {
    this.logCache.clear();
    this.pendingLog = null;
    this.pendingAppends.clear();
  }

  private readonly eventObservers = new Map<
    (event: SessionEvent) => void,
    ReadonlySet<string> | undefined
  >();

  /**
   * Transcripts already folded, oldest entry first, so the least recently read one is the one evicted.
   *
   * The run loop reads a session's history several times per round — the context builder, the pre-step
   * hook and the title path — and every one of those reads used to re-parse and re-fold the whole log, so
   * the cost of a run grew with the square of its length. The cache is bounded rather than unbounded
   * because an agent-host process outlives the sessions it reads.
   */
  private logCache = new Map<string, LogCacheEntry>();

  /** `LOG_CACHE_BYTES`, as a field so a test can exercise eviction by size without allocating the real budget. */
  private cacheBytes = LOG_CACHE_BYTES;

  /** Events appended inside an open transaction, folded into the cache when that transaction commits. */
  private pendingLog: Map<string, SessionEvent[]> | null = null;

  /** Messages appended but not yet written, per session: one commit per batch instead of one per message. */
  private pendingAppends = new Map<string, QueuedMessage[]>();

  private transactionDepth = 0;

  /** True while a flush is writing, so that the flush a transaction starts with is not attempted twice. */
  private flushing = false;

  /** Notifications follow COMMIT and cannot affect its outcome or the cached durable payload. */
  observeEvents(listener: (event: SessionEvent) => void, types?: ReadonlySet<string>): () => void {
    this.eventObservers.set(listener, types);
    return () => {
      this.eventObservers.delete(listener);
    };
  }

  private notifyCommitted(events: readonly SessionEvent[]): void {
    for (const event of events)
      for (const [listener, types] of this.eventObservers) {
        if (types && !types.has(event.type)) continue;
        try {
          listener(structuredClone(event));
        } catch {
          /* Observation cannot undo a committed fact. */
        }
      }
  }

  /**
   * The `messages` rows as they are on disk, which is the one read that can disagree with the transcript.
   *
   * The transcript is folded from the log, so this is the write-through side of the I8 promise: both are
   * written from a single call, and a divergence here is the only way to see that the two halves of that
   * call stopped agreeing. It is also what a second connection would read, minus the connection.
   */
  messagesFromTable(sessionId: string): Message[] {
    this.port.get(sessionId);
    this.flush(sessionId);
    return this.port.db
      .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
      .all(sessionId)
      .map((row) => this.hydrateMessage(JSON.parse(String(row.body))) as Message);
  }

  /**
   * The message projection: the transcript is the fold of the durable log, not a table a second writer
   * could add to. Sessions written before schema v14 had their log backfilled by the migration, so this
   * reads the same history those sessions always had.
   */
  messages(id: string): Message[] {
    this.port.get(id);
    this.flush(id);
    return this.transcriptOf(id);
  }

  /**
   * The durable log, oldest first. `afterSeq` reads only what was appended since a checkpoint.
   *
   * `limit` is for a reader that *walks* a log rather than consuming it: the event reader a session's owner can
   * call needs a page, not the tail of a ten-thousand-event history held in memory to print fifty lines of it.
   * Without a limit the behaviour is unchanged, which is what every existing reader relies on.
   */
  events(id: string, afterSeq = 0, limit?: number): SessionEvent[] {
    // A reader must not be shown less than is recorded, so buffered appends are written before a read.
    this.flush(id);
    if (afterSeq === 0 && limit === undefined) return this.logOf(id).events;
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) {
      // A delta read asks for a tail, and the cached log is ordered by seq, so the position is found by
      // bisection rather than by filtering the whole log: a reader that polls for new events should not pay for
      // the history it has already seen on every poll.
      let low = 0;
      let high = cached.events.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (cached.events[middle]!.seq <= afterSeq) low = middle + 1;
        else high = middle;
      }
      return frozen(cached.events.slice(low, limit === undefined ? undefined : low + limit));
    }
    // A delta read asks for a tail, not for the log, so it stays a bounded query instead of reading the
    // whole history to answer a question about its end.
    return frozen(this.readEvents(id, afterSeq, limit));
  }

  /**
   * The process record, read as a bounded page rather than as the log.
   *
   * `limit` is required because this is a cursor read: the caller asks for a page and gets the sequence to
   * continue from. The type filter is pushed into the query rather than applied to what came back, which is what
   * keeps a diagnostic reader from parsing — and failing on — message payloads it was never going to show.
   */
  auditEvents(id: string, afterSeq = 0, limit = 200): SessionEvent[] {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid audit cursor');
    this.port.get(id);
    this.flush(id);
    return frozen(this.readEvents(id, afterSeq, limit, AUDIT_SESSION_EVENTS));
  }

  private readEvents(
    id: string,
    afterSeq: number,
    limit?: number,
    types?: readonly string[],
  ): SessionEvent[] {
    return this.port.db
      .prepare(
        `SELECT seq,session_id AS sessionId,type,data,at FROM session_events WHERE session_id=? AND seq>?${
          types ? ` AND type IN (${types.map(() => '?').join(',')})` : ''
        } ORDER BY seq${limit === undefined ? '' : ' LIMIT ?'}`,
      )
      .all(id, afterSeq, ...(types ?? []), ...(limit === undefined ? [] : [limit]))
      .map((row) => ({
        seq: Number(row.seq),
        sessionId: String(row.sessionId),
        type: String(row.type),
        data: this.hydratePayload(JSON.parse(String(row.data)) as Record<string, unknown>),
        at: String(row.at),
      }));
  }

  /**
   * A stored image as a live one, or an error naming the address that could not be resolved.
   *
   * The error is the point: an image silently dropped on the way out would leave the model and the person
   * alike believing a screenshot was part of the conversation. An inline image — one written before schema
   * v21, or by a caller that stored something this build does not recognise — is returned untouched, so
   * hydration is idempotent and the two shapes coexist without a migration.
   */
  private hydrateImage(value: unknown): unknown {
    if (!isImageReference(value)) return value;
    const row = this.port.db
      .prepare('SELECT mime_type AS mimeType,bytes FROM attachment_blobs WHERE hash=?')
      .get(value.hash);
    if (!row) throw new Error(`Attachment ${value.hash} is missing from the session database`);
    const data = Buffer.from(row.bytes as Uint8Array).toString('base64');
    const reference = value as unknown as Record<string, unknown>;
    // `data` goes back exactly where `hash` was, so the hydrated image has the same key order the live one did
    // (`{data,mimeType}` from the attachment validator, `{mimeType,data,name}` from a tool). Key order is not
    // cosmetic here: I8 compares rows and fold as strings.
    return Object.fromEntries(
      Object.entries(reference).map(([key, entry]) => [
        key === 'hash' ? 'data' : key,
        key === 'hash' ? data : entry,
      ]),
    );
  }

  /** One message out of a row or a log payload, with every reference resolved back to bytes. */
  private hydrateMessage(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const images = (value as { images?: unknown }).images;
    if (!Array.isArray(images)) return value;
    return { ...value, images: images.map((image) => this.hydrateImage(image)) };
  }

  /**
   * One log payload, hydrated. `{message}` is the shape that carries model-visible bytes — the `message.*`
   * entries written by `writeMessages` — and every other payload is a fact about the session rather than part
   * of a transcript, so it is returned as it was read.
   */
  private hydratePayload(data: Record<string, unknown>): Record<string, unknown> {
    return 'message' in data ? { ...data, message: this.hydrateMessage(data.message) } : data;
  }

  /**
   * The inbox: inputs accepted for this session that no turn ever folded in.
   *
   * Read from the log rather than from a table, because the log is where the acceptance, the consumption and the
   * discard are written (see `input.queued` in `./events.ts`) and a second copy in a column would be a second
   * answer. Only the three inbox types are queried, so this stays cheap on a session with a long history, and
   * the answer is a snapshot: it is "what is left over", which is what a client shows and what a person sends
   * again.
   */
  pendingInputs(id: string): PendingSessionInput[] {
    this.flush(id);
    const rows = this.port.db
      .prepare(
        `SELECT seq,session_id AS sessionId,type,data,at FROM session_events
         WHERE session_id=? AND type IN ('input.queued','input.consumed','input.discarded') ORDER BY seq`,
      )
      .all(id)
      .map((row) => ({
        seq: Number(row.seq),
        sessionId: String(row.sessionId),
        type: String(row.type),
        data: JSON.parse(String(row.data)) as Record<string, unknown>,
        at: String(row.at),
      }));
    return foldPendingInputs(rows);
  }

  /**
   * Settle every input the inbox still shows as undelivered, and say how many there were.
   *
   * The log is the authority here, not the queue in memory: an entry is written when it is accepted, so
   * everything still pending — the live queue's contents included — is in the log, and a caller that only
   * cleared an array would leave the log saying the input is still waiting. That is what makes clearing work
   * for the leftovers of a run that already ended or crashed, which is when a person most needs it.
   */
  discardPendingInputs(id: string, reason: string): number {
    const ids = this.pendingInputs(id).map((item) => item.id);
    if (ids.length) this.recordEvent(id, 'input.discarded', { ids, reason });
    return ids.length;
  }

  /** The log of a session, from the cache when it is still current and read from the file when it is not. */
  private logOf(id: string): LogCacheEntry {
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) return cached;
    // The version is sampled *before* the log is read, so a commit that lands during the read makes this entry
    // stale on its next use instead of being stamped with the newer version and hidden behind it.
    const dataVersion = this.dataVersion();
    const events = this.readEvents(id, 0);
    const entry: LogCacheEntry = {
      events: frozen(events),
      messages: null,
      readable: null,
      dataVersion,
      bytes: approximateBytes(events),
    };
    // A read inside an open transaction sees that transaction's uncommitted rows, which a rollback would
    // make fiction; only a statement-level read is a read of committed state.
    if (this.transactionDepth === 0) this.rememberLog(id, entry);
    return entry;
  }

  /**
   * The transcript, folded on first ask and kept after that.
   *
   * The refusal lives in the fold, so it happens when a transcript is asked for and not when the log is: a reader
   * diagnosing a session written by a newer build can still read the log, and is stopped only where it would be
   * shown a shorter history. Every *other* derived answer goes through `checkedLog` for the same reason.
   */
  private transcriptOf(id: string): Message[] {
    const entry = this.logOf(id);
    entry.messages ??= frozen(foldMessages(entry.events));
    return entry.messages;
  }

  /**
   * The log, refusing an event this build cannot interpret, for a reader that is about to derive state from it.
   *
   * The check is over the *whole* log and once per loaded log, and both halves are deliberate. Whole, because a
   * projection that resumes from a checkpoint only folds the events after it: an unknown type before that point
   * was either seen (and refused) by the build that wrote the checkpoint or was written by a build that knew it,
   * and in the second case folding from the checkpoint would never notice. Once, because the answer cannot change
   * while the entry is current — another connection's commit drops the entry, exactly as it drops the transcript.
   */
  checkedLog(id: string): readonly SessionEvent[] {
    const entry = this.logOf(id);
    if (entry.readable === null) {
      assertKnownEvents(entry.events);
      entry.readable = true;
    }
    return entry.events;
  }

  private cachedLog(id: string): LogCacheEntry | undefined {
    const entry = this.logCache.get(id);
    if (!entry) return undefined;
    // Another connection committed since this fold was taken, so the fold may be a prefix of the log rather
    // than the log: it is caught up rather than trusted, which keeps a second writer's events visible here.
    if (entry.dataVersion !== this.dataVersion()) return this.catchUp(id, entry);
    this.rememberLog(id, entry); // recency: the entry read most recently is the last one evicted
    return entry;
  }

  /**
   * Bring a cached log up to date by reading only what was written after it, or drop it when that is not possible.
   *
   * Any commit by another connection — to any session, not just this one — bumps `data_version`, and the cache
   * used to answer by throwing the whole entry away. With a second process writing (a Host and the CLI, a parent
   * and a sub-agent process), every read of a long session therefore re-read and re-folded its log from seq 0.
   * The log is append-only and `seq` is assigned in commit order, so the events after the entry's last seq are
   * exactly what it is missing; they are read and folded on, the same way this connection's own appends are.
   *
   * The two cases that are not an append are handled by dropping the entry: the session was deleted by the other
   * connection (its rows are gone, and an entry would keep answering for it), or the tail cannot be folded (an
   * event this build does not know — the full read that follows refuses it exactly where it always did).
   */
  private catchUp(id: string, entry: LogCacheEntry): LogCacheEntry | undefined {
    // Sampled before the read, as `logOf` does: a commit that lands during it makes this entry stale next time.
    const dataVersion = this.dataVersion();
    try {
      if (!this.port.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) {
        this.logCache.delete(id);
        return undefined;
      }
      const tail = this.readEvents(id, entry.events.at(-1)?.seq ?? 0);
      const next: LogCacheEntry = tail.length
        ? {
            events: frozen([...entry.events, ...tail]),
            messages: entry.messages
              ? frozen(appendFoldedMessages([...entry.messages], tail))
              : null,
            // Events another build wrote are not vouched for: the next derived read checks the log again.
            readable: null,
            dataVersion,
            bytes: entry.bytes + approximateBytes(tail),
          }
        : { ...entry, dataVersion };
      this.rememberLog(id, next);
      return next;
    } catch {
      this.logCache.delete(id);
      return undefined;
    }
  }

  private rememberLog(id: string, entry: LogCacheEntry): void {
    this.logCache.delete(id);
    this.logCache.set(id, entry);
    let bytes = 0;
    for (const cached of this.logCache.values()) bytes += cached.bytes;
    // The newest entry is never evicted: `size > 1` keeps the one just read, however large it is.
    while (
      this.logCache.size > 1 &&
      (this.logCache.size > LOG_CACHE_ENTRIES || bytes > this.cacheBytes)
    ) {
      const oldest = this.logCache.keys().next().value;
      if (oldest === undefined) break;
      bytes -= this.logCache.get(oldest)!.bytes;
      this.logCache.delete(oldest);
    }
  }

  /**
   * `PRAGMA data_version` is SQLite's own answer to "did somebody else write?", which is the one thing a
   * cache of a shared database cannot learn from its own bookkeeping: SQLite bumps it when another
   * connection commits and leaves it alone when this one does.
   */
  private dataVersion(): number {
    return Number(this.port.db.prepare('PRAGMA data_version').get()?.data_version ?? 0);
  }

  /**
   * The session's durable cursor: the seq of the newest record it has.
   *
   * This is what a live frame is stamped with. Every durable fact already has a seq — the log assigns it and
   * every reader uses it as a cursor — and the live channel used to carry no cursor at all, so a client that
   * lost frames had no way to say where it was up to and no way to find out that it had lost any: the only
   * recovery was to re-read the session from the beginning (or, in a carrier that owns its Host, to restart
   * it). Stamping each frame with the log position it is ordered against turns "how much have you seen?" into
   * a number the client can keep and hand back.
   *
   * Read through the same cache and the same freshness rule every other read uses, rather than from a counter
   * of its own. A second mechanism here would be a second answer: this process's own writes are folded into the
   * cached log as they happen, and another connection's commit invalidates that cache (SQLite's `data_version`),
   * so "where does the log end" cannot drift from what a reader would fold. An unflushed append is not durable
   * yet and so is not in the mark, which is the safe direction: the replay that follows a cursor re-reads those
   * events rather than skipping them.
   */
  lastSeq(id: string): number {
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) return cached.events.at(-1)?.seq ?? 0;
    const seq = Number(
      this.port.db.prepare('SELECT MAX(seq) AS seq FROM session_events WHERE session_id=?').get(id)
        ?.seq ?? 0,
    );
    return seq;
  }

  /**
   * The newest payload of one event type in a session, or `undefined` when the session has none.
   *
   * For the questions whose answer is "what did the last one say" rather than "read me the history". The envelope
   * writer is the one that needs it: before it records a prompt and a tool catalogue, it asks whether this session
   * already holds them under the same digest, and a writer that read the whole log to answer that would make every
   * run pay for the session's entire past. The query walks the log backwards and stops at the first match, which
   * the `(session_id, seq)` index serves.
   */
  newestPayload(id: string, type: SessionEventType): Record<string, unknown> | undefined {
    const row = this.port.db
      .prepare(
        'SELECT data FROM session_events WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1',
      )
      .get(id, type);
    if (!row) return undefined;
    const data: unknown = JSON.parse(String(row.data));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  }

  /**
   * Append one durable fact. Every state change goes through here, so the log stays the record.
   *
   * `stored` is the payload as it is written to disk when that differs from the payload in memory. It exists
   * for one case — a `message.*` entry whose images are content addresses on disk and bytes in this process —
   * so that a reader of the file pays for one copy of a picture while the fold that follows this very write
   * still hands the model the bytes.
   */
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored: Record<string, unknown> = data,
  ): void {
    // A fact never overtakes the appends it is ordered against, so buffered messages go first.
    if (this.transactionDepth === 0) this.flush(id);
    const at = new Date().toISOString();
    const written = this.port.db
      .prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)')
      .run(id, type, JSON.stringify(stored), at);
    const event: SessionEvent = {
      seq: Number(written.lastInsertRowid),
      sessionId: id,
      type,
      data,
      at,
    };
    if (this.transactionDepth > 0) {
      const pending = (this.pendingLog ??= new Map());
      const queued = pending.get(id);
      if (queued) queued.push(event);
      else pending.set(id, [event]);
      return;
    }
    try {
      this.extendLog(id, [event]);
    } catch {
      this.logCache.delete(id);
    }
    this.notifyCommitted([event]);
  }

  /**
   * Fold what was just appended into the cached transcript, so the read that follows a write costs the
   * new event rather than the whole history.
   *
   * The events are copied into the fold instead of referenced: a caller that keeps a reference to the
   * object it appended and changes it later must not be able to change a transcript the model has
   * already been shown.
   */
  private extendLog(id: string, appended: readonly SessionEvent[]): void {
    const entry = this.logCache.get(id);
    if (!entry) return;
    if (entry.dataVersion !== this.dataVersion()) {
      // Another connection committed first, so its events may sit between the entry and these. The appended
      // events are already committed, so reading the tail picks them up in seq order together with theirs.
      this.catchUp(id, entry);
      return;
    }
    const stored = appended.map((event) => ({ ...event, data: structuredClone(event.data) }));
    this.rememberLog(id, {
      events: frozen([...entry.events, ...stored]),
      messages: entry.messages ? frozen(appendFoldedMessages([...entry.messages], stored)) : null,
      // Appended events come from `recordEvent`, whose type is this build's own, so a log already checked stays
      // checked; one that has not been checked stays unchecked and pays for the check when a derived read asks.
      readable: entry.readable,
      dataVersion: entry.dataVersion,
      bytes: entry.bytes + approximateBytes(stored),
    });
  }

  /** Fold a committed transaction's events into the cache; a failed one leaves nothing behind. */
  private applyPendingLog(): void {
    const pending = this.pendingLog;
    this.pendingLog = null;
    if (!pending) return;
    try {
      for (const [id, events] of pending) this.extendLog(id, events);
    } catch {
      // Folding into the cache is an optimisation: if it will not take, the next read rebuilds instead.
      this.logCache.clear();
    }
    for (const events of pending.values()) this.notifyCommitted(events);
  }

  /**
   * Append a message to the session.
   *
   * Outside a transaction the message is buffered and written by `flush`, because a round appends several
   * messages in a row — the assistant message that requests tools, then one result per tool — and it was
   * the commits, not the rows, that cost: one transaction per message measured 0.74ms, and the same
   * messages written in one batch cost a fraction of that. Nothing observable changes: everything that
   * could read the message, or order another fact against it, flushes first.
   */
  append(id: string, message: Message): void {
    // Everything that can fail about appending happens here, at the call site: serialising the message,
    // projecting its search text, and computing the title a user message gives the session. A message that
    // cannot be written is refused now rather than poisoning a batch that is written later. Image bytes are
    // hashed here too, so the only thing `writeMessages` has left to do with them is insert them.
    const { stored, blobs } = storedMessage(message);
    const queued: QueuedMessage = {
      message,
      stored,
      body: JSON.stringify(stored),
      searchText: messageSearchText(message),
      blobs,
      title: message.role === 'user' ? sessionTitle(message) : null,
    };
    // Inside a transaction the batch is already the atomic unit; there is nothing left to coalesce.
    if (this.transactionDepth > 0) {
      this.writeMessages(id, [queued]);
      return;
    }
    const pending = this.pendingAppends.get(id);
    if (pending) pending.push(queued);
    else this.pendingAppends.set(id, [queued]);
    if ((pending?.length ?? 1) >= APPEND_BATCH_LIMIT) this.flush(id);
  }

  /**
   * Write what is buffered, and say so.
   *
   * `flush` is the point at which an append is promised to survive a crash. A reader of the session, an
   * event recorded for it, a run that ends and a store that closes all flush first, so the only appends
   * that a crash can lose are the ones a reader had not been shown yet. The safety barrier the run loop
   * adds to that list is the one that matters: the message naming a tool call is flushed *before* the
   * tool runs, because a crash mid-tool has to leave the record that lets recovery report the outcome as
   * unknown instead of letting the call be replayed as if it had never happened.
   */
  flush(id?: string): void {
    // Inside a transaction there is nothing to write here: `transaction` empties the buffer before it
    // opens, and an append made while it is open goes straight to the database (see `append`).
    if (this.transactionDepth > 0) return;
    // `transaction` flushes before it opens, and this is the flush it is calling: one pass, no recursion.
    if (this.flushing) return;
    const ids =
      id === undefined ? [...this.pendingAppends.keys()] : this.pendingAppends.has(id) ? [id] : [];
    if (!ids.length) return;
    this.flushing = true;
    try {
      this.transaction(() => {
        for (const sessionId of ids) {
          const messages = this.pendingAppends.get(sessionId);
          if (messages) this.writeMessages(sessionId, messages);
        }
      });
    } finally {
      this.flushing = false;
    }
    // Only after the commit: a batch that failed to write is left in the buffer rather than dropped.
    for (const sessionId of ids) this.pendingAppends.delete(sessionId);
  }

  private writeMessages(id: string, batch: readonly QueuedMessage[]): void {
    const insert = this.port.db.prepare(
      'INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)',
    );
    const insertBlob = this.port.db.prepare(
      'INSERT OR IGNORE INTO attachment_blobs(hash,mime_type,bytes,size,created_at) VALUES(?,?,?,?,?)',
    );
    const retitle = this.port.db.prepare("UPDATE sessions SET title=? WHERE id=? AND title=''");
    for (const queued of batch) {
      // Inside the same transaction as the row that names them: a message cannot be durable while the bytes
      // it refers to are not, and a rolled-back batch leaves no blob behind either.
      for (const blob of queued.blobs)
        insertBlob.run(blob.hash, blob.mimeType, blob.bytes, blob.size, new Date().toISOString());
      insert.run(id, queued.body, queued.searchText);
      // The log entry and the row are written together: the projection and the write-through table can
      // never disagree about what happened, and a crash cannot leave one without the other. The log gets the
      // stored shape while the live object keeps its bytes, so the fold that reads this process's own writes
      // still shows the model an image rather than a reference to one.
      this.recordEvent(
        id,
        messageEventType(queued.message),
        { message: queued.message },
        { message: queued.stored },
      );
      if (queued.title !== null) retitle.run(queued.title, id);
    }
  }

  /**
   * Runs `fn` in a transaction, or joins the one already open.
   *
   * SQLite has no nested transactions, and nesting is now easy to reach by accident: `beginRun` settles
   * a previously interrupted run, which appends a message, which writes its log entry — three levels that
   * must all land or none of them. Joining the open transaction is what makes that composition work
   * instead of throwing "cannot start a transaction within a transaction".
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    // A fact written inside this transaction must not overtake appends that are still buffered.
    this.flush();
    this.port.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const value = fn();
      this.port.db.exec('COMMIT');
      this.transactionDepth--;
      // Reads during the transaction bypassed the cache, because they had to see this transaction's own
      // uncommitted rows. Now that it has committed, the events it appended can be folded in as a batch.
      this.applyPendingLog();
      return value;
    } catch (error) {
      this.transactionDepth--;
      if (this.pendingLog) this.pendingLog = null;
      try {
        this.port.db.exec('ROLLBACK');
      } catch {
        // A commit that failed on its own has already ended the transaction; there is nothing to undo.
      }
      throw error;
    }
  }
}
