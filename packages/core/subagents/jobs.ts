import type { JobProducer, JobSnapshot } from '../../protocol/jobs.ts';
import type { SubAgentRole } from '../../protocol/index.ts';
import type { ResidentChild, SubAgentResidency } from './residency.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
/** The window the command output ring uses too, so both kinds answer with a comparably sized chunk. */
const OUTPUT_WINDOW = 3000;
export interface AssignedChild {
  id: string;
  role: SubAgentRole;
  objective: string;
  childSessionId: string;
  /** When the delegation was recorded, which is the closest thing a child has to a start time. */
  at: string;
  /**
   * Persona and model, when the delegation named them, so a child resumed in another process is the
   * same child. See `subagent.assigned` in `packages/storage/events.ts` for what else is recorded.
   */
  persona?: string;
  model?: string;
}
/**
 * The children a session recorded delegating to, read from its log; the authority across restarts.
 */
export function assignedChildren(store: SessionStore, sessionId: string): AssignedChild[] {
  const found: AssignedChild[] = [];
  for (const event of store.events(sessionId)) {
    if (event.type !== 'subagent.assigned') continue;
    const id = String(event.data.id ?? '');
    const childSessionId = String(event.data.childSessionId ?? '');
    if (!id || !childSessionId) continue;
    found.push({
      id,
      role: (event.data.role as SubAgentRole | undefined) ?? 'general',
      objective: String(event.data.objective ?? ''),
      childSessionId,
      at: event.at,
      ...(typeof event.data.persona === 'string' && event.data.persona
        ? { persona: event.data.persona }
        : {}),
      ...(typeof event.data.model === 'string' && event.data.model
        ? { model: event.data.model }
        : {}),
    });
  }
  return found;
}
/**
 * A sub-agent as a job. Output is the child's durable transcript, so `job_output` behaves the same
 * whether the child is mid-turn, idle or from an earlier process.
 */
export function subAgentJobProducer(options: {
  store: SessionStore;
  residency: SubAgentResidency;
}): JobProducer {
  const { store, residency } = options;
  const resident = (id: string, scope: string) =>
    residency.list(scope).find((entry) => entry.childSessionId === id);
  const durable = (id: string, scope: string) =>
    assignedChildren(store, scope).find((entry) => entry.childSessionId === id);
  /**
   * The child's answer text from `cursor` on, at most the last `OUTPUT_WINDOW` characters. Offsets
   * index the assistant texts joined by newlines, but only the messages the window reaches are
   * joined.
   */
  const outputFrom = (childSessionId: string, cursor: number | undefined) => {
    const parts: string[] = [];
    for (const message of store.messages(childSessionId))
      if (message.role === 'assistant' && message.content) parts.push(message.content);
    let length = 0;
    for (const [index, part] of parts.entries()) length += part.length + (index ? 1 : 0);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > length))
      throw new Error('Invalid output cursor');
    const start = cursor === undefined ? length : Math.max(cursor, length - OUTPUT_WINDOW);
    const pieces: string[] = [];
    let end = length;
    for (let index = parts.length - 1; index >= 0 && end > start; index--) {
      const piece = index ? `\n${parts[index]!}` : parts[index]!;
      pieces.push(piece);
      end -= piece.length;
    }
    return {
      start,
      output: pieces
        .reverse()
        .join('')
        .slice(start - end),
    };
  };
  const describe = (child: ResidentChild): Record<string, unknown> => ({
    objective: child.objective,
    turns: child.turns,
    depth: child.depth,
    inputTokens: child.usage.inputTokens,
    outputTokens: child.usage.outputTokens,
  });
  /**
   * An undefined `cursor` asks for the job summary (`job_list`); a cursor past the end is refused.
   * `known` lets a caller pass an already-resolved child to avoid re-reading the log.
   */
  const read = (
    id: string,
    scope: string,
    cursor?: number,
    known?: { child?: ResidentChild; record?: AssignedChild },
  ): JobSnapshot => {
    const child = known ? known.child : resident(id, scope);
    const record = known ? known.record : child ? undefined : durable(id, scope);
    if (!child && !record)
      throw new Error(
        `No sub-agent of this session was delegated to ${id}; call job_list to see the ones it was`,
      );
    const childSessionId = child?.childSessionId ?? record!.childSessionId;
    const { start, output } = outputFrom(childSessionId, cursor);
    const spent = store.statistics(childSessionId);
    return {
      id,
      kind: 'subagent',
      sessionId: scope,
      label: child?.objective ?? record!.objective,
      // A cold child has no activation, so it is neither running nor idle: it is waiting to be resumed,
      // and saying "idle" would claim a process holds it.
      status: child?.status ?? 'cold',
      createdAt: record?.at ?? new Date(child!.lastUsedAt).toISOString(),
      output,
      nextCursor: start + output.length,
      truncated: start > 0,
      detail: child
        ? describe(child)
        : {
            objective: record!.objective,
            role: record!.role,
            // Reported, never a limit: there is no grant to count down (see `residency.ts`), so a cold child
            // answers with what it actually spent rather than with what it has left.
            spentTokens: spent.inputTokens + spent.outputTokens,
          },
    };
  };
  return {
    kind: 'subagent',
    // Ownership is the lineage rule, not a lookup: a child of another session is not reachable from here,
    // so it is not "unknown" either — it belongs to a different caller.
    owns: ({ id, scope }) => Boolean(resident(id, scope) ?? durable(id, scope)),
    list: (scope) => {
      // Resolved once for the whole list rather than once per child: both sources are log/registry scans.
      const children = residency.list(scope);
      const live = new Set(children.map((child) => child.childSessionId));
      const recorded = assignedChildren(store, scope).filter(
        (entry) => !live.has(entry.childSessionId),
      );
      return children
        .map((child) => read(child.childSessionId, scope, undefined, { child }))
        .concat(
          recorded.map((entry) => read(entry.childSessionId, scope, undefined, { record: entry })),
        );
    },
    output: async (job) => {
      job.signal?.throwIfAborted();
      const child = resident(job.id, job.scope);
      // Waiting only means something for a child that is still working: a cold child has nothing in flight.
      if (child && job.waitMs > 0 && child.status === 'running') {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            job.signal?.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, Math.min(job.waitMs, 5000));
          job.signal?.addEventListener('abort', finish, { once: true });
        });
      }
      job.signal?.throwIfAborted();
      // Cursor validation and every transcript/statistics read must succeed before taking delivery.
      const snapshot = read(job.id, job.scope, job.cursor);
      /**
       * Reading the transcript is taking delivery, so record it as collected (by child session id).
       */
      if (resident(job.id, job.scope) ?? durable(job.id, job.scope))
        store.recordEvent(job.scope, 'subagent.collected', { ids: [job.id] });
      return snapshot;
    },
    kill: async (job) => {
      const child = resident(job.id, job.scope);
      if (!child) {
        const record = durable(job.id, job.scope);
        if (!record)
          throw new Error(
            `No sub-agent of this session was delegated to ${job.id}; call job_list to see the ones it was`,
          );
        // Idempotent, like stopping a finished command: report the final state instead of failing.
        return read(job.id, job.scope);
      }
      residency.get(job.id)?.interrupt();
      return read(job.id, job.scope);
    },
  };
}
