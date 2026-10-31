/**
 * Session retrieval: read-only tools that make a workspace's own history searchable by the model.
 *
 * 1. `search_sessions` returns FTS5's ranked snippets, not just session ids.
 * 2. `read_session_events` is a cursor (`afterSeq`, page limit, "more remain"), with per-event
 *    payload bounds that are announced.
 * 3. Scope is the workspace: sub-agent child sessions are excluded, and a session from another
 *    workspace is refused by name. Every tool is permission-free, so it works in read-only and
 *    planning runs.
 * 4. `search_session_events` searches within a log (approvals, failures, step boundaries) over a
 *    bounded prefix.
 * 5. `trace_session` folds the log run by run (rounds, tool calls, failures, endings).
 * 6. Filters are only what the store records: `parent` (`parent_session_id`) and `active`
 *    (`active_run`, not a liveness probe). No cwd filter (cwd is the workspace) and no surface
 *    filter.
 * 7. Lineage is read from the session row, one level deep.
 */
import { isSessionEventType, SESSION_EVENT_TYPES } from '../storage/events.ts';
import type { SessionEvent } from '../storage/events.ts';
import { MAX_SEARCH_SESSIONS } from '../storage/sqlite.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { Message, Tool } from '../protocol/index.ts';

export const SEARCH_SESSIONS = 'search_sessions';
export const READ_SESSION_EVENTS = 'read_session_events';
export const SEARCH_SESSION_EVENTS = 'search_session_events';
export const TRACE_SESSION = 'trace_session';
/** How many events one page may hold, and how much text one page may spend. */
const MAX_READ_EVENTS = 200;
const MAX_READ_CHARS = 12_000;
/** One event's payload is summarised to this much; the log holds whole tool results, and a page holds many. */
const MAX_EVENT_CHARS = 600;
const MAX_TYPES = 8;
/** How many events one search or trace may walk; the cap is disclosed with a cursor to continue. */
const MAX_SCAN_EVENTS = 20_000;
/** How many matches a search shows, and how many runs a trace lists, before it says it truncated. */
const MAX_MATCHES = 40;
const MAX_TRACED_RUNS = 20;
/** How many child sessions a trace names; the count is always the real one. */
const MAX_LINEAGE_CHILDREN = 10;
/** One event's payload may spend this much in a search hit or a trace line. */
const MAX_HIT_CHARS = 300;
export interface SessionQueryDeps {
  store: SessionStore;
  /** The workspace this run may read history from. A session outside it is refused by name. */
  workspace: string;
  /** The session this run is in, so a result can say "this one". */
  sessionId: string;
}
export function sessionQueryTools(deps: SessionQueryDeps): Tool[] {
  return [searchTool(deps), readEventsTool(deps), searchEventsTool(deps), traceTool(deps)];
}
/**
 * The session a query is about, or why it cannot be read. "Not found" and "belongs to another
 * workspace" are distinct answers.
 */
function scoped(deps: SessionQueryDeps, requested: unknown): { id: string } | string {
  const id =
    requested === undefined || requested === '' ? deps.sessionId : String(requested).trim();
  if (!id) return 'A session id is required.';
  let session: { workspace: string };
  try {
    session = deps.store.get(id);
  } catch {
    return `No session "${id}" in this workspace.`;
  }
  if (session.workspace !== deps.workspace)
    return `Session ${id} belongs to another workspace (${session.workspace}); this run reads only ${deps.workspace}.`;
  return { id };
}
/** A bounded read of one session's log, and whether the scan stopped before the end. */
function scan(
  store: SessionStore,
  sessionId: string,
): { events: SessionEvent[]; complete: boolean } {
  const events = store.events(sessionId, 0, MAX_SCAN_EVENTS + 1);
  return { events: events.slice(0, MAX_SCAN_EVENTS), complete: events.length <= MAX_SCAN_EVENTS };
}
/**
 * One page of a log under a type filter. With a filter, the walk continues until the page is full,
 * the log ends or the scan bound is spent (reported as "more may remain"), so a short page never
 * reads as the end.
 */
function readEventPage(
  store: SessionStore,
  sessionId: string,
  after: number,
  limit: number,
  types: Set<string> | null,
): { shown: SessionEvent[]; more: boolean; cursor: number } {
  const matched: SessionEvent[] = [];
  let cursor = after;
  let scanned = 0;
  while (matched.length <= limit && scanned < MAX_SCAN_EVENTS) {
    const want = Math.min(limit + 1 - matched.length, MAX_SCAN_EVENTS - scanned);
    const chunk = store.events(sessionId, cursor, want);
    if (!chunk.length) break;
    for (const event of chunk) {
      cursor = event.seq;
      if (!types || types.has(event.type)) matched.push(event);
    }
    scanned += chunk.length;
    // A short chunk is the end of the log: nothing recorded after it can match, so the page is complete.
    if (chunk.length < want)
      return { shown: matched.slice(0, limit), more: matched.length > limit, cursor };
  }
  return {
    shown: matched.slice(0, limit),
    more: matched.length > limit || scanned >= MAX_SCAN_EVENTS,
    cursor,
  };
}
function searchTool(deps: SessionQueryDeps): Tool {
  return {
    name: SEARCH_SESSIONS,
    description:
      'Search this workspace’s earlier conversations and get the excerpts that matched. Use it when the user refers to something from a previous session ("the deploy checklist we made"), or before re-deriving a decision that may already be written down. Results are ranked by relevance, not by date, and each session comes with the message positions to continue from — read one with read_session_events. Only this workspace is searched; sub-agents’ private sessions are not conversations and are left out.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Words to look for. All of them must appear in a message (or in a session title).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_SESSIONS,
          description: `How many sessions to return, best match first. Defaults to 5, at most ${MAX_SEARCH_SESSIONS}.`,
        },
        parent: {
          type: 'string',
          minLength: 1,
          description:
            'Only sessions recorded under this session id — the sub-agents it delegated to, and the branches forked from it. Use it to follow one session’s own work instead of the workspace’s conversations. An id outside this workspace is refused.',
        },
        active: {
          type: 'boolean',
          description:
            'Only sessions with a run recorded as in flight. This is the stored fact the session list shows, not a check that the process is still alive: a run whose owner died stays recorded until it is reclaimed.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const query = String(args.query).trim();
        if (!query) return { isError: true, content: 'A search needs a non-empty query.' };
        const requested = args.limit === undefined ? 5 : Number(args.limit);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(1, Math.trunc(requested)), MAX_SEARCH_SESSIONS)
          : 5;
        // An unreadable parent is refused by name (`scoped`), not answered with an empty list.
        let parent: string | undefined;
        if (args.parent !== undefined) {
          const asked = String(args.parent).trim();
          if (!asked) return { isError: true, content: 'A parent filter needs a session id.' };
          const resolved = scoped(deps, asked);
          if (typeof resolved === 'string') return { isError: true, content: resolved };
          parent = resolved.id;
        }
        const active = args.active === true;
        const page = deps.store.searchSessions(query, {
          workspace: deps.workspace,
          limit,
          ...(parent === undefined ? {} : { parent }),
          ...(active ? { activeOnly: true } : {}),
        });
        const hits = page.hits;
        /** What was searched, said out loud: a filtered search must not read as "this workspace has nothing". */
        const scope = parent
          ? `the sessions started by ${parent}`
          : active
            ? 'the sessions with a run in flight'
            : 'this workspace';
        if (!hits.length)
          return {
            isError: false,
            content: `Nothing in ${scope} matches "${query}". Sessions with no such words are not listed, and a sub-agent’s own session is never searched.`,
          };
        const lines: string[] = [
          `${hits.length} session(s) in ${scope} match "${query}", best first:`,
        ];
        for (const hit of hits) {
          const { session, matches, total } = hit;
          const mine = session.id === deps.sessionId ? ' · this session' : '';
          lines.push(
            '',
            `### ${session.title?.trim() || '(untitled)'} · ${session.id} · created ${session.createdAt}${mine}`,
            matches.length
              ? `${total} matching message(s), showing ${matches.length}:`
              : 'matched by title; no message repeats those words:',
          );
          for (const match of matches)
            lines.push(`- [${match.role || 'message'}] ${match.snippet} (seq ${match.seq})`);
        }
        lines.push(
          '',
          `Read one with ${READ_SESSION_EVENTS}({ sessionId: "…" }) — it walks that session’s log from a position.`,
        );
        return { isError: false, content: lines.join('\n') };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
function readEventsTool(deps: SessionQueryDeps): Tool {
  return {
    name: READ_SESSION_EVENTS,
    description:
      'Read the durable log of one session, oldest first: what ran, what was decided, what was said, in order. `afterSeq` continues from where a previous read stopped (each line carries its `seq`), and the result says whether events remain. Payloads are summarised rather than dumped — the log holds whole tool results — so this is for seeing what happened and in which order; to read a session’s prose, search it instead. A session from another workspace is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          description:
            'The session to read, as returned by search_sessions or given in the session list.',
        },
        afterSeq: {
          type: 'integer',
          minimum: 0,
          description:
            'Read only what was appended after this position. Defaults to 0 (the whole log).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_EVENTS,
          description: `How many events to return, at most ${MAX_READ_EVENTS}. Defaults to 50.`,
        },
        types: {
          type: 'array',
          maxItems: MAX_TYPES,
          items: { type: 'string', maxLength: 40 },
          description:
            'Only these event types, for example ["message.user","message.assistant"]. An unknown type is refused rather than ignored.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const sessionId = String(args.sessionId).trim();
        if (!sessionId) return { isError: true, content: 'A read needs a session id.' };
        const session = deps.store.get(sessionId);
        if (session.workspace !== deps.workspace)
          return {
            isError: true,
            content: `Session ${sessionId} belongs to another workspace (${session.workspace}); this run reads only ${deps.workspace}.`,
          };
        const requestedAfter = args.afterSeq === undefined ? 0 : Number(args.afterSeq);
        if (!Number.isInteger(requestedAfter) || requestedAfter < 0)
          return { isError: true, content: '`afterSeq` must be a non-negative integer.' };
        const requestedLimit = args.limit === undefined ? 50 : Number(args.limit);
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(Math.max(1, Math.trunc(requestedLimit)), MAX_READ_EVENTS)
          : 50;
        const types = readTypes(args.types);
        if (typeof types === 'string') return { isError: true, content: types };
        // A bounded walk, so a filtered short page is not mistaken for the end of the log.
        const page = readEventPage(deps.store, sessionId, requestedAfter, limit, types);
        const { shown, more } = page;
        const lines: string[] = [
          `session ${session.id} · ${session.title?.trim() || '(untitled)'} · from seq ${requestedAfter}`,
          `${shown.length} event(s) shown${types ? ` (filtered to ${[...types].join(', ')})` : ''}`,
        ];
        let chars = 0;
        let emitted = 0;
        for (const event of shown) {
          const line = `seq ${event.seq}  ${event.type}  ${summariseEvent(event)}`;
          if (chars + line.length > MAX_READ_CHARS) {
            lines.push(
              `[stopped at ${event.seq}: this page reached ${MAX_READ_CHARS} characters; continue from here]`,
            );
            break;
          }
          chars += line.length;
          emitted++;
          lines.push(line);
        }
        // The cursor is the last event shown; an empty page advances by the walk's position so the
        // cursor moves.
        const last = shown[emitted - 1]?.seq ?? (shown.length ? requestedAfter : page.cursor);
        if (more || emitted < shown.length)
          lines.push(
            '',
            `more remain — call ${READ_SESSION_EVENTS}({ sessionId: "${session.id}", afterSeq: ${last}${
              types ? `, types: ${JSON.stringify([...types])}` : ''
            } })`,
          );
        else lines.push('', 'that is the end of the log.');
        return { isError: false, content: lines.join('\n') };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
function searchEventsTool(deps: SessionQueryDeps): Tool {
  return {
    name: SEARCH_SESSION_EVENTS,
    description:
      'Search inside one durable session log — the whole record, not only what was said: approvals asked and answered, questions, failures, step boundaries, sub-agent hand-offs, compactions. Use it to find when something happened, in which round, or the exact record of a decision before quoting it. Case-insensitive substring match; `types` narrows it to event types. Pass `afterSeq` (the last hit’s `seq`) to continue past a long section, and read the events themselves with read_session_events. Defaults to this session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Text to look for, matched against each event as the log summarises it.',
        },
        sessionId: { type: 'string', minLength: 1, description: 'Defaults to this session.' },
        types: {
          type: 'array',
          maxItems: MAX_TYPES,
          items: { type: 'string', maxLength: 40 },
          description:
            'Only these event types, for example ["approval.decided","run.finished"]. An unknown type is refused.',
        },
        afterSeq: {
          type: 'integer',
          minimum: 0,
          description: 'Continue after this position. Defaults to 0 (the start of the log).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MATCHES,
          description: `How many matches to show, at most ${MAX_MATCHES}. Defaults to 20.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const scopedSession = scoped(deps, args.sessionId);
        if (typeof scopedSession === 'string') return { isError: true, content: scopedSession };
        const query = String(args.query).trim().toLowerCase();
        if (!query) return { isError: true, content: 'A search needs something to look for.' };
        const types = readTypes(args.types);
        if (typeof types === 'string') return { isError: true, content: types };
        const after = args.afterSeq === undefined ? 0 : Number(args.afterSeq);
        if (!Number.isInteger(after) || after < 0)
          return { isError: true, content: '`afterSeq` must be a non-negative integer.' };
        const requested = args.limit === undefined ? 20 : Number(args.limit);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(1, Math.trunc(requested)), MAX_MATCHES)
          : 20;
        const { events, complete } = scan(deps.store, scopedSession.id);
        const hits: SessionEvent[] = [];
        let scanned = 0;
        for (const event of events) {
          if (event.seq <= after) continue;
          scanned++;
          if (types && !types.has(event.type)) continue;
          if (!summariseEvent(event).toLowerCase().includes(query)) continue;
          hits.push(event);
          if (hits.length > limit) break;
        }
        const more = hits.length > limit;
        const shown = more ? hits.slice(0, limit) : hits;
        const session = deps.store.get(scopedSession.id);
        const lines = [
          `session ${session.id} · ${session.title?.trim() || '(untitled)'} · matching "${args.query}"${types ? ` in ${[...types].join(', ')}` : ''}`,
          `${shown.length} match(es) in ${scanned} event(s) scanned${complete ? '' : ` (scan stopped at ${MAX_SCAN_EVENTS} events; the log continues)`}`,
        ];
        for (const hit of shown) {
          const text = summariseEvent(hit);
          const bounded = text.length > MAX_HIT_CHARS ? `${text.slice(0, MAX_HIT_CHARS)}…` : text;
          lines.push(`seq ${hit.seq}  ${hit.type}  ${bounded}`);
        }
        if (!shown.length) lines.push('', 'No match in the scanned part of the log.');
        else if (more || !complete)
          lines.push(
            '',
            `more may remain — call ${SEARCH_SESSION_EVENTS}({ sessionId: "${session.id}", query: ${JSON.stringify(args.query)}, afterSeq: ${shown.at(-1)!.seq}${types ? `, types: ${JSON.stringify([...types])}` : ''} })`,
          );
        return { isError: false, content: lines.join('\n') };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
/** One run as the trace renders it: what it did, how it ended, and what failed on the way. */
interface TracedRun {
  runId: string;
  steps: number;
  tools: Map<string, number>;
  /** Each failure's rendered line, and whether the excerpt it carries was cut short. */
  failures: { text: string; truncated: boolean }[];
  subagents: string[];
  status?: string;
  error?: string;
  code?: string;
  interrupted?: boolean;
}
function traceTool(deps: SessionQueryDeps): Tool {
  return {
    name: TRACE_SESSION,
    description:
      'Outline what happened in one session, run by run: how many rounds each run took, which tools it called and how often, which calls failed, which sub-agents it delegated, and how each run ended. It also names where the session sits in the tree — the session it descends from and the sub-agent sessions recorded under it. Use it to orient yourself in a long or resumed conversation before reading anything in detail. Newest runs are kept when there are more than the limit; read the detail with read_session_events, or find one fact with search_session_events. Defaults to this session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'Defaults to this session.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TRACED_RUNS,
          description: `How many runs to show, most recent last, at most ${MAX_TRACED_RUNS}. Defaults to 10.`,
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const scopedSession = scoped(deps, args.sessionId);
        if (typeof scopedSession === 'string') return { isError: true, content: scopedSession };
        const requested = args.limit === undefined ? 10 : Number(args.limit);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(1, Math.trunc(requested)), MAX_TRACED_RUNS)
          : 10;
        const { events, complete } = scan(deps.store, scopedSession.id);
        const runs: TracedRun[] = [];
        const names = new Map<string, string>();
        let current: TracedRun | undefined;
        for (const event of events) {
          const data = event.data as Record<string, unknown>;
          if (event.type === 'run.started') {
            current = {
              runId: String(data.runId ?? ''),
              steps: 0,
              tools: new Map(),
              failures: [],
              subagents: [],
            };
            runs.push(current);
            names.clear();
            continue;
          }
          // A run's records are bracketed by its start and finish, which attributes message tool
          // calls to runs.
          if (!current) continue;
          if (event.type === 'run.finished') {
            current.status = String(data.status ?? '');
            if (data.error) current.error = String(data.error);
            if (data.code) current.code = String(data.code);
            continue;
          }
          if (event.type === 'run.interrupted') {
            current.interrupted = true;
            current.status = current.status ?? 'interrupted';
            continue;
          }
          if (event.type === 'step.finished') {
            current.steps++;
            continue;
          }
          if (event.type === 'message.assistant') {
            const message = data.message as Message | undefined;
            if (message?.role !== 'assistant') continue;
            for (const call of message.toolCalls ?? []) {
              current.tools.set(call.name, (current.tools.get(call.name) ?? 0) + 1);
              names.set(call.id, call.name);
            }
            continue;
          }
          if (event.type === 'message.tool') {
            const message = data.message as Message | undefined;
            if (message?.role !== 'tool' || !message.isError) continue;
            const name = names.get(message.toolCallId) ?? 'a tool';
            const flat = String(message.content).replace(/\s+/g, ' ');
            // Decide truncation on the excerpt's own length, not the rendered line.
            current.failures.push({
              text: `${name}: ${flat.slice(0, MAX_HIT_CHARS)}`,
              truncated: flat.length > MAX_HIT_CHARS,
            });
            continue;
          }
          if (event.type === 'subagent.assigned') {
            const objective = String(data.objective ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 120);
            current.subagents.push(objective || '(no objective)');
          }
        }
        const shown = runs.length > limit ? runs.slice(runs.length - limit) : runs;
        const session = deps.store.get(scopedSession.id);
        const lines = [
          `session ${session.id} · ${session.title?.trim() || '(untitled)'}`,
          `${runs.length} run(s) recorded, ${shown.length} shown${runs.length > shown.length ? ` (oldest ${runs.length - shown.length} omitted)` : ''}${complete ? '' : `; the log was scanned only to ${MAX_SCAN_EVENTS} events`}`,
        ];
        /**
         * Where this session sits in the tree, from the lineage columns. A deleted parent is
         * reported, not fatal.
         */
        if (session.parentSessionId) {
          let title = '(no longer in this database)';
          try {
            title = deps.store.get(session.parentSessionId).title?.trim() || '(untitled)';
          } catch {
            // The parent's row is gone; the id is still the fact worth reporting.
          }
          lines.push('', `lineage: started from ${session.parentSessionId} · ${title}`);
        }
        const children = deps.store.childSessions(scopedSession.id);
        if (children.length) {
          const shownChildren = children.slice(0, MAX_LINEAGE_CHILDREN);
          lines.push(
            '',
            `${children.length} sub-agent session(s) recorded under this one${children.length > shownChildren.length ? `, first ${shownChildren.length} shown` : ''}:`,
          );
          for (const child of shownChildren)
            lines.push(
              `  ${child.id} · ${child.title?.trim() || '(untitled)'} · created ${child.createdAt}${child.activeRun ? ' · running' : ''}`,
            );
        }
        if (!runs.length) lines.push('', 'Nothing has run in this session yet.');
        for (const run of shown) {
          const facts = [`${run.steps} round(s)`];
          const calls = [...run.tools.values()].reduce((total, count) => total + count, 0);
          facts.push(`${calls} tool call(s)`);
          if (run.subagents.length) facts.push(`${run.subagents.length} sub-agent(s)`);
          facts.push(run.status ? `ended ${run.status}` : 'still open or cut off');
          lines.push('', `run ${run.runId || '(unnamed)'} — ${facts.join(', ')}`);
          if (run.tools.size)
            lines.push(
              `  tools: ${[...run.tools.entries()].map(([name, count]) => `${name}×${count}`).join(', ')}`,
            );
          for (const objective of run.subagents) lines.push(`  delegated: ${objective}`);
          for (const failure of run.failures)
            lines.push(`  failed: ${failure.text}${failure.truncated ? '…' : ''}`);
          if (run.interrupted) lines.push('  interrupted: the process that owned it disappeared');
          if (run.error) lines.push(`  error: ${run.error}`);
          if (run.code) lines.push(`  failure code: ${run.code}`);
        }
        return { isError: false, content: lines.join('\n') };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
/** The type filter, or the message explaining why it cannot be used. */
function readTypes(value: unknown): Set<string> | null | string {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return '`types` must be an array of event type names.';
  if (!value.length) return null;
  const names: string[] = [];
  for (const entry of value) {
    const name = String(entry).trim();
    if (!isSessionEventType(name))
      return `Unknown event type "${name}". Known types: ${SESSION_EVENT_TYPES.slice(0, 12).join(', ')}, …`;
    names.push(name);
  }
  return new Set(names);
}
/**
 * One event as a line: message events as role and text, everything else as bounded JSON with
 * truncation announced.
 */
function summariseEvent(event: SessionEvent): string {
  const message = (event.data as { message?: { role?: unknown; content?: unknown } }).message;
  const text = message
    ? `${String(message.role ?? '')}: ${bounded(String(message.content ?? ''))}`
    : bounded(safeJson(event.data));
  return text;
}
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}
function bounded(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EVENT_CHARS ? `${flat.slice(0, MAX_EVENT_CHARS)}…` : flat;
}
