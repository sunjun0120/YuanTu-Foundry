/**
 * Continuation tokens, issued and spent by the service that produced the page.
 *
 * A cursor is a promise about a *version* of the workspace, and the only way to keep that promise is to make the
 * token something the caller cannot write. So the token is an opaque random id, never a path, an offset, a line
 * number or a PID: a model that could spell a cursor could move the window anywhere it liked, including outside
 * the scope it was given, and the token would stop being a continuation and start being an argument.
 *
 * Everything the token is bound to is checked when it is spent — the workspace, the query's own hash, and that
 * the files the previous page reported are still the files the next page will skip past. A token that fails any
 * of those is refused with `cursor-invalid` and the caller searches again, which is the cheap and correct
 * outcome: re-running a search costs a scan, and honouring a stale cursor reports a file that is not there.
 *
 * The state lives in this process on purpose. A cursor that survived a restart would have to be validated against
 * a workspace nobody has looked at since, and "the host restarted" is not a fact a tool result can check.
 */
import { createHash, randomUUID } from 'node:crypto';

export const CURSOR_INVALID = 'cursor-invalid';

/** What a caller sees when a token is unknown, expired, foreign, or describes a tree that has moved. */
export class CursorInvalidError extends Error {
  readonly code = CURSOR_INVALID;
  constructor(reason: string) {
    super(`${CURSOR_INVALID}: ${reason}. Search again to get a fresh page.`);
    this.name = 'CursorInvalidError';
  }
}

/** A file the previous page touched, with the fingerprint it was reported under. */
export interface CursorWitness {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Everything a cursor is bound to. Any difference between issue and spend invalidates the token. */
export interface CursorState {
  workspace: string;
  queryHash: string;
  sourceVersion: string | null;
  /** Where the next page starts: after this path and line. `null` means the beginning. */
  after: { path: string; line: number } | null;
  /** The last file of the page before this one, so a change to it is detectable. */
  witness: CursorWitness | null;
}

interface Held {
  state: CursorState;
  expiresAt: number;
}

export const CURSOR_TTL_MS = 5 * 60_000;
export const MAX_CURSORS_PER_WORKSPACE = 32;

export class CursorStore {
  private cursors = new Map<string, Held>();
  private now: () => number;
  private ttlMs: number;
  private limit: number;

  constructor(options: { now?: () => number; ttlMs?: number; limit?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? CURSOR_TTL_MS;
    this.limit = options.limit ?? MAX_CURSORS_PER_WORKSPACE;
  }

  /** Issues a token for this state, dropping the oldest token from the same workspace if the cap is reached. */
  issue(state: CursorState): string {
    const token = randomUUID();
    this.prune();
    const held = [...this.cursors.entries()].filter(
      ([, entry]) => entry.state.workspace === state.workspace,
    );
    if (held.length >= this.limit) {
      // Oldest first: a caller working through pages is holding a handful at most, and the ones it stopped
      // using are the ones to lose.
      held.sort((left, right) => left[1].expiresAt - right[1].expiresAt);
      for (const [key] of held.slice(0, held.length - this.limit + 1)) this.cursors.delete(key);
    }
    this.cursors.set(token, { state, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * Spends a token, checking every binding it carries.
   *
   * The order of the checks is the order of the questions: does this token exist, does it belong to this
   * workspace, is it still the same query, and is it still about the same tree.
   */
  take(token: string, expecting: { workspace: string; queryHash: string }): CursorState {
    this.prune();
    const held = this.cursors.get(token);
    if (!held) throw new CursorInvalidError('unknown or expired cursor');
    if (held.state.workspace !== expecting.workspace)
      throw new CursorInvalidError('cursor belongs to another workspace');
    if (held.state.queryHash !== expecting.queryHash)
      throw new CursorInvalidError('the query changed since this cursor was issued');
    return held.state;
  }

  /** Forgets every cursor that reported one of these paths as its last item. */
  invalidate(paths: readonly string[]): void {
    if (!paths.length) return;
    const changed = new Set(paths);
    for (const [token, held] of [...this.cursors])
      if (held.state.witness && changed.has(held.state.witness.path)) this.cursors.delete(token);
  }

  /** Forgets every cursor for one workspace, without touching the others. */
  invalidateWorkspace(workspace: string): void {
    for (const [token, held] of [...this.cursors])
      if (held.state.workspace === workspace) this.cursors.delete(token);
  }

  clear(): void {
    this.cursors.clear();
  }

  size(): number {
    this.prune();
    return this.cursors.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, held] of [...this.cursors])
      if (held.expiresAt <= now) this.cursors.delete(token);
  }
}

/**
 * A stable hash of a search request.
 *
 * Two searches that differ in any way that changes what page two means — the query, the mode, the case rule, the
 * path, the filters — must not share a cursor, so every one of them is in the hash. The order of include and
 * exclude patterns is part of it too: the tool treats them as a set but the caller wrote a list, and a different
 * list is a different request.
 */
export function queryHashOf(parts: Record<string, unknown>): string {
  // Key order is the record's, so the hash is over the *values* rather than over how they were written down.
  const canonical = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((key) => [key, parts[key]]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
