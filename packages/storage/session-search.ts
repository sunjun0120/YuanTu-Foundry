import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_SESSIONS,
  ftsQuery,
  readSearchCursor,
  writeSearchCursor,
} from './session-schema.ts';
import type { Session, SessionSearchHit, SessionSearchPage } from './session-schema.ts';

export interface SessionSearchPort {
  readonly db: DatabaseSync;
  flush(id?: string): void;
  get(id: string): Session;
}

/** Indexed conversation listing and paged search share the original visibility rules. */
export class SessionSearch {
  private readonly port: SessionSearchPort;
  constructor(port: SessionSearchPort) {
    this.port = port;
  }

  list(query = '', workspace?: string): Session[] {
    if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid session search');
    // Titles and the full-text index are written with the message, so a list or a search has to see the
    // appends that have not been written yet — a message the user just sent is searchable immediately.
    this.port.flush();
    const needle = query.trim();
    // Search runs against the FTS5 index over `messages.search_text` instead of
    // `json_extract(body,…)` + `instr` over every row. The old form parsed each message body — the
    // same blob that carries base64 image data — for every session on every keystroke of the search
    // box, which is why it was an unindexed full table scan. The title check stays a substring test
    // so a partial word still matches a session name.
    return this.port.db
      .prepare(
        `SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId FROM sessions
         WHERE (? IS NULL OR workspace=?)
           AND (parent_session_id IS NULL OR fork_message_count IS NOT NULL)
           AND (?='' OR instr(lower(title),lower(?))>0 OR
             (? IS NOT NULL AND EXISTS (
               SELECT 1 FROM messages m JOIN messages_fts ON messages_fts.rowid=m.seq
               WHERE m.session_id=sessions.id AND messages_fts MATCH ?)))
         ORDER BY created_at DESC,rowid DESC`,
      )
      .all(
        workspace ?? null,
        workspace ?? null,
        needle,
        needle,
        needle ? ftsQuery(needle) : null,
        needle ? ftsQuery(needle) : null,
      ) as unknown as Session[];
  }

  /**
   * Full-text search across this workspace's conversations, with the text that matched.
   *
   * `list(query)` answers "which sessions mention this"; this answers "where, and what did it say" — the model
   * asking "how did we solve this last time" needs the sentence, not the session id. Three properties are
   * deliberate:
   *
   * - **Ranked by session, not by row.** bm25 over the same `messages_fts` index the session list uses, summed
   *   over each session's matching messages: a conversation that mentions the words five times outranks one that
   *   mentions them once, which is the question "which conversation was this" rather than "which message scored
   *   best". Within a session the excerpts are ranked the same way, so the first line is the strongest evidence.
   * - **Bounded on every axis.** The query length, the sessions returned and the matches per session are all
   *   capped here rather than by the caller: a search that returns the whole database is the failure mode this
   *   exists to avoid, and a caller that forgets to bound it should not be able to.
   * - **The same visibility rule as the session list.** A sub-agent's child session is not a conversation of this
   *   workspace — it is reachable through `job_output` — so it is excluded unless asked for. Forks are included,
   *   because a fork *is* one of the user's conversations.
   * - **`parent` replaces that rule instead of narrowing it.** Asking for one session's children and then
   *   filtering them out again would be an empty answer to a question that has one, so `parent` is the scope
   *   rather than an extra condition on top of "conversations only". `activeOnly` is a separate axis and only
   *   ever narrows: sessions with a run recorded as in flight.
   *
   * A query with nothing indexable in it (punctuation, an empty string) matches nothing rather than throwing:
   * user text must never reach `MATCH` verbatim, and `ftsQuery` is where that is decided.
   */
  searchSessions(
    query: string,
    options: {
      workspace?: string;
      limit?: number;
      perSession?: number;
      includeChildren?: boolean;
      /** Sessions recorded as children of this id: the sub-agents it delegated to, and the forks branched from it. */
      parent?: string;
      /** Sessions whose `active_run` is set — the same recorded fact the session list shows, not a liveness probe. */
      activeOnly?: boolean;
      /**
       * Where to continue from, as returned by the previous page's `cursor`.
       *
       * Opaque on purpose: it encodes a position in *this* query's ordering, so a caller that changed the query,
       * the scope or the page size should not try to reuse one — the page it lands on would be from a different
       * list. It is bounded work, not a stable index into a growing table: the order is computed per call, so a
       * session appended between two pages can shift what the next page holds. That is the same trade every
       * search over a changing corpus makes, and the reason this returns a cursor rather than promising offsets.
       */
      cursor?: string;
    } = {},
  ): SessionSearchPage {
    if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid session search');
    const needle = query.trim();
    const match = needle ? ftsQuery(needle) : null;
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 5)), MAX_SEARCH_SESSIONS);
    const perSession = Math.min(
      Math.max(1, Math.trunc(options.perSession ?? 3)),
      MAX_SEARCH_MATCHES,
    );
    const workspace = options.workspace ?? null;
    // A cursor that cannot be read is refused rather than ignored: silently starting from the top again is how a
    // caller that meant "the next page" gets the first one, with no sign that anything went wrong.
    const offset = options.cursor === undefined ? 0 : readSearchCursor(options.cursor);
    // Buffered appends are written before a read, for the same reason `list` does it: a message the user just
    // sent is searchable immediately.
    this.port.flush();
    const parent = options.parent?.trim() || null;
    const visibility = parent
      ? 'AND s.parent_session_id = ?'
      : options.includeChildren
        ? ''
        : 'AND (s.parent_session_id IS NULL OR s.fork_message_count IS NOT NULL)';
    // The parent binding sits where the visibility clause does, so it is collected separately from the two
    // workspace bindings the scope always contributes.
    const scope: (string | null)[] = parent ? [parent] : [];
    const activeClause = options.activeOnly === true ? 'AND s.active_run IS NOT NULL' : '';
    /**
     * The candidate slice is sized by the *page*, not by how far into the ranking the caller has walked.
     *
     * `limit * perSession * 8` rows was the bound when one call returned one page; with a cursor the returned
     * order has to be recomputed on every call anyway, so the honest bound is "enough rows to rank a page of
     * sessions well", and a caller walking deep into a large result set pays the same constant per page rather
     * than a window that grows with its position. The consequence is documented on `cursor`: this walks within
     * the ranked window rather than promising every match in the database, which is what it promised before.
     */
    const window = limit * perSession * 8;
    const hits = new Map<string, SessionSearchHit>();
    /** Relevance per session, summed as the rows come in — see the note on ordering below. */
    const scores = new Map<string, number>();
    if (match) {
      /**
       * Ranked rows first, sessions second.
       *
       * FTS5's `bm25()` cannot be aggregated (`unable to use function bm25 in the requested context`), so the
       * per-session total is summed here from a bounded, ranked slice of rows: wide enough that a session with
       * several matches is fully seen, and still a constant, so a search never reads a table proportionally to
       * how much text matches.
       */
      const rows = this.port.db
        .prepare(
          `SELECT m.session_id AS sessionId, m.seq AS seq,
                  s.workspace,s.created_at AS createdAt,s.active_run AS activeRun,s.title,s.parent_session_id AS parentSessionId,
                  COALESCE(json_extract(m.body,'$.role'),'') AS role,
                  snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                  bm25(messages_fts) AS rank
           FROM messages_fts
           JOIN messages m ON messages_fts.rowid = m.seq
           JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ?
             AND (? IS NULL OR s.workspace = ?)
             ${visibility}
             ${activeClause}
           ORDER BY rank ASC, m.seq DESC
           LIMIT ?`,
        )
        .all(match, workspace, workspace, ...scope, window) as unknown as {
        sessionId: string;
        seq: number;
        workspace: string;
        createdAt: string;
        activeRun: string | null;
        title: string;
        parentSessionId: string | null;
        role: string;
        snippet: string;
        rank: number;
      }[];
      for (const row of rows) {
        // The session's own columns ride the ranked query, so building a hit costs no second lookup per row.
        const hit = this.sessionHit(hits, row.sessionId, {
          id: row.sessionId,
          workspace: row.workspace,
          createdAt: row.createdAt,
          activeRun: row.activeRun,
          title: row.title,
          parentSessionId: row.parentSessionId,
        });
        // `bm25` is "lower is better" and negative; summing the negation makes "more relevant" larger.
        scores.set(row.sessionId, (scores.get(row.sessionId) ?? 0) - Number(row.rank));
        if (hit.matches.length < perSession)
          hit.matches.push({
            seq: Number(row.seq),
            role: String(row.role),
            snippet: String(row.snippet).replace(/\s+/g, ' ').trim(),
          });
      }
      /**
       * Then the totals, and the order.
       *
       * The order is by *summed* relevance rather than by best single row, because the question is which
       * conversation is about this: a short message that happens to contain both words would otherwise outrank a
       * long conversation that is entirely about them. The total comes from its own count — the row slice above
       * is capped, so reporting its length as the total would be a guess dressed as a fact. One grouped query
       * answers it for every candidate session at once, rather than one count per session found.
       */
      if (hits.size) {
        const ids = [...hits.keys()];
        const totals = this.port.db
          .prepare(
            `SELECT m.session_id AS sessionId,COUNT(*) AS total FROM messages_fts
             JOIN messages m ON messages_fts.rowid = m.seq
             WHERE messages_fts MATCH ? AND m.session_id IN (${ids.map(() => '?').join(',')})
             GROUP BY m.session_id`,
          )
          .all(match, ...ids) as unknown as { sessionId: string; total: number }[];
        for (const row of totals) hits.get(String(row.sessionId))!.total = Number(row.total);
      }
      /**
       * The tie-break is the session id, so the order is total rather than merely sorted: two sessions with the
       * same summed relevance have to come back in the same order on the next page, or a page boundary between
       * them could show one twice and the other never.
       */
      const ordered = [...hits.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          (scores.get(rightId) ?? 0) - (scores.get(leftId) ?? 0) ||
          left.session.createdAt.localeCompare(right.session.createdAt) ||
          leftId.localeCompare(rightId),
      );
      hits.clear();
      for (const [id, hit] of ordered) hits.set(id, hit);
    }
    /**
     * Then the sessions whose *title* matches, appended after the ranked ones.
     *
     * A session named "deploy checklist" should be findable by that name even when no message repeats it, which
     * is what `list` already did with a substring test — the same lower-cased `instr` keeps a partial word working.
     * They are collected for the whole window and ordered the same way every call, for the same reason the
     * ranked ones are: a page boundary inside this section must not depend on which call is asking.
     */
    if (hits.size < window) {
      const titled = this.port.db
        .prepare(
          `SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId
           FROM sessions s
           WHERE (? = '' OR instr(lower(COALESCE(s.title,'')), lower(?)) > 0)
             AND (? IS NULL OR s.workspace = ?)
             ${visibility}
             ${activeClause}
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(needle, needle, workspace, workspace, ...scope, window) as unknown as Session[];
      for (const session of titled) this.sessionHit(hits, session.id, session);
    }
    const ranked = [...hits.values()];
    const page = ranked.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      hits: page,
      ...(next < ranked.length ? { cursor: writeSearchCursor(next) } : {}),
      /** How many sessions this call could rank — the size of the window the pages walk, not the whole database. */
      rankedTotal: ranked.length,
    };
  }

  /** The bucket for one session, created on first sight. */
  private sessionHit(
    hits: Map<string, SessionSearchHit>,
    sessionId: string,
    known?: Session,
  ): SessionSearchHit {
    const existing = hits.get(sessionId);
    if (existing) return existing;
    const session = known ?? this.port.get(sessionId);
    const hit: SessionSearchHit = { session, matches: [], total: 0 };
    hits.set(sessionId, hit);
    return hit;
  }
}
