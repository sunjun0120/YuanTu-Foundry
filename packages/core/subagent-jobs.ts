import type { JobProducer, JobSnapshot } from '../protocol/jobs.ts';
import type { SubAgentRole } from '../protocol/index.ts';
import type { ResidentChild, SubAgentResidency } from './residency.ts';
import type { SessionStore } from '../storage/sqlite.ts';
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
   * Who the child speaks as, and which model it answers on, when the delegation named them.
   *
   * Both belong to the delegation rather than to the child's transcript, so a child resumed in a process that
   * never saw the delegation would otherwise come back as somebody else: the deployment's persona instead of its
   * own, and the *parent's* model instead of the one the task chose — silently, because the resumed turn looks
   * exactly like a normal one.
   *
   * The rest of a delegation is deliberately not here; `subagent.assigned` in `packages/storage/events.ts` states
   * what the record carries and what it does not.
   */
  persona?: string;
  model?: string;
}
/**
 * The children a session durably recorded delegating to, read back out of its own log.
 *
 * This is the authority that survives a restart: a child whose activation is gone is still a child that was
 * delegated, and it is resumed from this record when it is messaged — with the descriptor the delegation named,
 * which is what makes the resumed turn the same child rather than a lookalike.
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
 * A sub-agent as a job.
 *
 * The output is its own durable transcript rather than an in-flight buffer: a child's text lands in its own
 * session as it finishes each round, so `job_output` answers the same way whether the child is mid-turn,
 * idle, or was left behind by an earlier process — and a number that only grows makes the cursor honest.
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
  const transcript = (childSessionId: string) =>
    store
      .messages(childSessionId)
      .filter((message) => message.role === 'assistant' && message.content)
      .map((message) => message.content)
      .join('\n');
  const describe = (child: ResidentChild): Record<string, unknown> => ({
    objective: child.objective,
    turns: child.turns,
    depth: child.depth,
    inputTokens: child.usage.inputTokens,
    outputTokens: child.usage.outputTokens,
  });
  /**
   * `cursor` undefined means "tell me what the job is, not what is new" — the shape `job_list` wants, and
   * the shape the command listing had. A cursor beyond the end is refused rather than clamped, because
   * silently returning everything would turn a caller's bookkeeping bug into a wall of text.
   *
   * `known` lets a caller that has already resolved the child hand it in: reading the log once per listed
   * child would make `job_list` quadratic in the number of delegations a session has ever made.
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
    const text = transcript(childSessionId);
    if (
      cursor !== undefined &&
      (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
    )
      throw new Error('Invalid output cursor');
    const start =
      cursor === undefined ? text.length : Math.max(cursor, text.length - OUTPUT_WINDOW);
    const output = text.slice(start);
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
      const child = resident(job.id, job.scope);
      // Waiting only means something for a child that is still working: a cold child has nothing in flight.
      if (child && job.waitMs > 0 && child.status === 'running') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(job.waitMs, 5000));
          job.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      job.signal?.throwIfAborted();
      /**
       * Reading the transcript *is* taking delivery.
       *
       * `job_output` and `collect_subagents` are two names for the same act — the parent reading what a child
       * produced — so both have to stop the reminder, or a parent that read the transcript through the job
       * tools would be told again on its next turn that it never collected the child. The id here is the child
       * session id and the reminder matches either id, which is why this can be recorded from here at all.
       */
      if (resident(job.id, job.scope) ?? durable(job.id, job.scope))
        store.recordEvent(job.scope, 'subagent.collected', { ids: [job.id] });
      return read(job.id, job.scope, job.cursor);
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
