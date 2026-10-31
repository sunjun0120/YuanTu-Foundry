/** The live event vocabulary every client allow-lists, and the durable event view a log reader receives. */
/**
 * Every event the agent can emit. A runtime array because clients allow-list against it (an omitted
 * type is silently dropped); the union is derived from it so the two stay in step.
 */
export const AGENT_EVENT_TYPES = [
  'statistics.updated',
  'run.started',
  'message.started',
  'message.delta',
  /** The model's reasoning, on its own channel so no consumer can mistake it for the answer. */
  'message.reasoning',
  'message.finished',
  'tool.started',
  'tool.finished',
  'tool.execution.started',
  'tool.execution.finished',
  /**
   * A call is waiting for its sandbox to be prepared (the Windows first workspace grant can be
   * slow). Live only. `active` opens and closes one call's entry; `callId` keeps calls sharing one
   * grant apart.
   */
  'tool.preparation',
  'approval.required',
  /**
   * What the human answered. Live for the panel; the durable record of the same name says who
   * allowed what.
   */
  'approval.decided',
  'question.required',
  'question.answered',
  /** The session's checklist changed, carrying the whole list so a client needs no second read. */
  'todo.written',
  /** Inner program effects survive a guest disconnect as known or unknown outcomes. */
  'program.call.settled',
  /**
   * The model declared workspace files as the session's deliverables. Live and durable; carries
   * path, size and digest at the moment of declaration, so readers need not re-read the file.
   */
  'deliverable.presented',
  /**
   * The session's goal changed, carrying the whole goal. Also written on each round under an active
   * goal, because the round count is part of the state.
   */
  'goal.changed',
  /**
   * The completion contract's evidence state as it changes. Live for the panel, durable for
   * reopened sessions.
   */
  'completion.updated',
  /**
   * A large completion fingerprint read is starting (`before`, `after` or `final`), with file and
   * byte counts. Live only, and only above a size threshold.
   */
  'completion.fingerprinting',
  'context.compacting',
  'context.compacted',
  /**
   * The compression could not be performed. Live only: there is no durable compaction to announce.
   * Clients clear the `context.compacting` indicator on it; older clients fall back to
   * `run.finished`.
   */
  'context.compaction.failed',
  /**
   * The budget prediction the round was decided on and what was done first (shortened results,
   * compression). Live only.
   */
  'context.forecast',
  /**
   * Model-visible context the runtime appended as a user message (policy output, pre-step
   * injections, the goal notice), naming its source. The event makes it observable; it does not
   * carry the content to the model.
   */
  'context.injected',
  /**
   * The provider refused a request for exceeding the context window. Emitted whether or not the run
   * recovered.
   */
  'context.overflow',
  /**
   * A round's request will be re-sent after a transient failure: which failure, which attempt, and
   * the wait. Live as well as durable so a waiting run does not look stuck.
   */
  'llm.retry',
  /**
   * An attempt that produced no bytes was re-sent on its own allowance, separate from `llm.retry`.
   * The next process reads this to know how much of that allowance a round used.
   */
  'llm.zero-byte-retry',
  /**
   * An attempt that spent its whole output allowance on hidden reasoning was re-sent once, asking
   * for action. Its own allowance.
   */
  'llm.reasoning-resend',
  /**
   * An attempt cut off inside a tool call was re-sent once with a note to split the change. Its own
   * allowance.
   */
  'llm.truncated-call-resend',
  'provider.degraded',
  /**
   * A write reverted an earlier one in the same run (whole file or one block). Recorded per hit to
   * measure back-and-forth; the transcript is unaffected.
   */
  'edit.oscillation',
  'provider.request.finished',
  /** Session metadata may arrive before or after its answer, independently of any run. */
  'session.title.updated',
  'context.summary.retry',
  /**
   * Which model and effort served a round, written only when either changes from the previous
   * round.
   */
  'llm.request',
  'input.queued',
  'input.consumed',
  'queue.changed',
  'resources.loaded',
  'task.step',
  'plan.proposed',
  /**
   * A planning run's plan was approved mid-run (`exit_plan_mode`) and the run continues executing
   * it. Unlike `plan.proposed`, this means work starts in this run. The durable record is the plan
   * row itself.
   */
  'plan.approved',
  'subagent.started',
  'subagent.delta',
  'subagent.tool',
  /**
   * A working child's turn time and spend so far, folded from its own frames. Live only; reloads
   * read the child's runs.
   */
  'subagent.progress',
  'subagent.finished',
  /**
   * Progress of an isolated child's result export. Live only; the durable record is
   * `subagent.workspace` or its failure.
   */
  'subagent.workspace.progress',
  /**
   * An isolated child's directory and the result it produced. Its own frame because the directory
   * is known before the turn and the result only after it.
   */
  'subagent.workspace',
  /**
   * An isolated child's work could not be frozen after its turn. A diagnostic beside the outcome:
   * the turn itself succeeded and its report is kept.
   */
  'subagent.workspace.failed',
  /**
   * A runtime invariant did not hold. Emitted for diagnostics even though the run is already
   * failing.
   */
  'invariant.violated',
  'run.finished',
] as const;
/**
 * One durable log record as a client reads it. `seq` is the cursor: assigned on append, never
 * repeated. `data` is typed by `type`.
 */
export interface SessionEventView {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  runId: string;
  /**
   * The session's durable cursor when this frame was emitted: every record up to this seq has been
   * announced live. A client keeps the highest seq seen and asks `session.events` for the rest
   * after a gap. Frames with no durable fact carry the mark unchanged.
   */
  seq: number;
  data: Record<string, unknown>;
}
