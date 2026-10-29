/** The live event vocabulary every client allow-lists, and the durable event view a log reader receives. */
/**
 * Every event the agent can emit. This is a runtime array, not just a type, because clients
 * allow-list incoming events against it — an omitted type is silently dropped for every consumer
 * instead of raising an error. Deriving the union from the array keeps the type and the runtime
 * list in step, so adding an event here is the only step needed.
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
   * A call is waiting for the sandbox that will run it.
   *
   * The Windows account backend's first workspace authorization propagates an inheritable grant over every
   * existing child and can outlast any deadline a person would call reasonable; the tool is announced but no
   * command has started. Live only: the state exists while the preparation is in flight, so a reader that missed
   * a frame loses the explanation for a slow call, not a fact about the conversation. `active` opens and closes
   * one call's entry; `callId` is what keeps two calls sharing one authorization from closing each other's entry.
   */
  'tool.preparation',
  'approval.required',
  /**
   * What the human answered. The live event lets a client settle its panel; the durable record (same name, in
   * the session log) is what lets a reopened session say who allowed what.
   */
  'approval.decided',
  'question.required',
  'question.answered',
  /** The session's checklist changed, carrying the whole list so a client needs no second read. */
  'todo.written',
  /** Inner program effects survive a guest disconnect as known or unknown outcomes. */
  'program.call.settled',
  /**
   * The model declared workspace files as the deliverables of this session.
   *
   * Live so a panel fills in while the run is still going, and durable because "what was handed to me" is
   * the one thing a person comes back for: a reopened session that lost it would show the work and not the
   * output. The whole declaration is carried — a path, its size and its digest at the moment it was named —
   * so a reader needs no second read of the file to say what was presented.
   */
  'deliverable.presented',
  /**
   * The session's goal changed, carrying the whole goal for the same reason `todo.written` does.
   *
   * One record per accepted change, including the round a run starts with an active goal: the round count is
   * part of the state, so a reader that skipped the rounds would read "3 rounds" off a goal that has had
   * seven, and the blocked floor is expressed in exactly that number.
   */
  'goal.changed',
  /**
   * The completion contract's current evidence state, announced as it changes.
   *
   * Live and durable: the live frame fills in the panel while the run is still repairing, and the durable record
   * (same name, in the session log) is what a reopened session reads to answer "did anything verify this".
   */
  'completion.updated',
  /**
   * A completion fingerprint of a large range is about to be read: its phase (`before` or `after` the checks, or the
   * `final` re-read) and how many files and bytes it covers. Live only, and only past a size worth announcing — the
   * reads that follow are what make a task's end slow on a large tree, and nothing said so until they were done.
   */
  'completion.fingerprinting',
  'context.compacting',
  'context.compacted',
  /**
   * The compression could not be performed, and the live answer to "is a compaction still running?".
   *
   * Live rather than durable, exactly like the two above it: what the run does about a failed compression is
   * decided in the moment (a caller that said `compactionFailure: 'send'` sends the request as it stands, one
   * that said `'throw'` fails the round), and what the *conversation* kept is already the session log's own
   * record — there is no durable compaction, so there is nothing durable to announce. A client that knows the
   * type clears the indicator it raised on `context.compacting`; a client that predates it never learns about
   * the frame at all (an unknown event type is ignored, and `run.finished` is what has always cleared that
   * state), which is why this is an addition rather than a change to `context.compacted`.
   */
  'context.compaction.failed',
  /**
   * The budget prediction the round was decided on: what the next request is expected to cost, what the run
   * has left, and what was done to the conversation first (shortened results, a compression). Live only — it
   * is one line per request, and the log already records the compressions themselves.
   */
  'context.forecast',
  /**
   * Model-visible context the runtime adds to the conversation rather than to the prompt — post-execute policy
   * output, pre-step injections, and the notice that announces the session's goal. It is appended as a user
   * message, so the event exists to make the addition observable live, and to say which of those sources it came
   * from, not to carry the content to the model.
   */
  'context.injected',
  /**
   * A request the provider refused because it exceeded the model's context window. Emitted whether or not the
   * run recovered from it, because "this conversation was too large for this model" is the fact an operator
   * needs when they later ask why a round was compressed or why a run failed.
   */
  'context.overflow',
  /**
   * A round's request is about to be re-sent after a transient failure, carrying which failure, which attempt
   * this is, and how long the run will wait first.
   *
   * Live as well as durable because the wait is the part the user experiences: a run that is silent for thirty
   * seconds looks stuck, and "the endpoint said 429, retrying in 4s (attempt 2 of 2)" is the difference between
   * waiting and giving up.
   */
  'llm.retry',
  /**
   * An attempt that produced no bytes at all was sent again, on its own allowance.
   *
   * Not folded into `llm.retry`: the two are different counts, and a product with a normal retry allowance must
   * not spend it on a re-send that duplicated nothing. The record is what the *next process* reads to know how
   * much of this allowance a round already used.
   */
  'llm.zero-byte-retry',
  /**
   * An attempt that spent its whole output allowance on reasoning, with nothing shown, was sent again once with a
   * note asking for the action instead of more deliberation. Its own allowance, for the same reason as above.
   */
  'llm.reasoning-resend',
  'provider.degraded',
  /**
   * A write that undid an earlier one in the same run: the whole file went back to a state it already had, or
   * one block of lines did while the rest of the file moved on. Recorded per hit rather than per notice, because
   * the count is what says how much a run spent going back and forth and whether telling it once helped. The
   * transcript is unaffected, so a client that ignores this loses only that measurement.
   */
  'edit.oscillation',
  'provider.request.finished',
  /** Session metadata may arrive before or after its answer, independently of any run. */
  'session.title.updated',
  'context.summary.retry',
  /**
   * How a round's request was shaped: which model and effort served it, recorded when either differs from the
   * previous round's. Deliberately a *change* log rather than one row per round — a run on its configured
   * model writes nothing at all, and a run that switches writes one row at the switch.
   */
  'llm.request',
  'input.queued',
  'input.consumed',
  'queue.changed',
  'resources.loaded',
  'task.step',
  'plan.proposed',
  /**
   * A planning run's plan was approved by the user mid-run (`exit_plan_mode`), so the run continues as an
   * executing one. Separate from `plan.proposed` because it is a different fact about the same plan object: the
   * client shows the plan either way, but only this one means "work is starting in *this* run", which is what
   * decides whether offering to execute the plan again would duplicate it. The durable record of an approval is
   * the plan row itself (`approved_at` and the status), exactly as it is for an approval from the panel.
   */
  'plan.approved',
  'subagent.started',
  'subagent.delta',
  'subagent.tool',
  /**
   * A working child's own numbers moved: how long its turns have run, and what it has spent so far.
   *
   * The card and the catalog both show a running child's tokens and time, and neither can be assembled from
   * the parent's events: the child's usage arrives with `subagent.finished`, and its turn clock is its own
   * session's. So the child's own frames are folded into one live shape here, and nothing durable is written
   * — the log already holds the child's runs, and a reload reads the same numbers out of them.
   */
  'subagent.progress',
  'subagent.finished',
  /**
   * How far an isolated child's result export has got.
   *
   * The first export of a child reads its whole working tree, and that read is the one part of a turn that has
   * nothing to show until it is over. The total is known before the first file is read; live only, because the
   * durable record is the result itself (`subagent.workspace`) or its failure. A client that ignores this event
   * loses nothing but the progress line.
   */
  'subagent.workspace.progress',
  /**
   * An isolated child's directory, and the result it produced.
   *
   * Its own frame rather than fields on `subagent.started` and `subagent.finished`, because the two facts it carries
   * become true at *different* moments than those two frames: the directory is decided before the child's turn begins,
   * and the result exists only after the turn has ended and been frozen. Folding either into an existing frame would
   * mean publishing a fact that is not yet true — a `finished` card claiming a result that was not exported, or a
   * `started` card claiming a directory nobody has validated.
   *
   * A client that shows where a child worked reads this; a client that does not can ignore it entirely.
   */
  'subagent.workspace',
  /**
   * An isolated child's work could not be frozen when its turn ended.
   *
   * Its own event rather than a line inside `subagent.finished`, because the two are different facts and a reader
   * has to be able to act on the second without parsing the first: the child's turn *did* happen — its report, its
   * usage and its journal are all recorded — and what failed is the export of what it changed. A parent that was
   * told its child failed would be losing the answer it paid for, so this is a diagnostic beside the outcome
   * rather than a replacement for it.
   */
  'subagent.workspace.failed',
  /**
   * A runtime invariant did not hold. Emitted for diagnostics even though the run is already failing at that
   * point: the log is where an operator sees a broken promise, and a host outlives many runs.
   */
  'invariant.violated',
  'run.finished',
] as const;
/**
 * One durable log record as a client reads it.
 *
 * The log's sequence number is the cursor: it is assigned by the store when the record is appended, it never
 * repeats, and a reader that asks for everything after the last one it saw gets exactly the records it is
 * missing. `data` stays open because the payload belongs to the record's type — a reader switches on `type`
 * and reads the fields it knows.
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
   * The session's durable cursor at the moment this frame was emitted: every record up to this seq has been
   * announced on the live channel.
   *
   * The log's own cursor, not a second numbering: a reader that has a frame has a position in the log, and the
   * two can be compared directly. That is what makes a gap recoverable — a client keeps the highest seq it has
   * seen and asks `session.events` for everything after it, instead of re-reading the session (or, on a carrier
   * that owns its Host, restarting it) because it cannot tell how much it missed.
   *
   * Frames that announce no durable fact — model deltas, statistics — carry the mark unchanged: they are
   * superseded by the durable frame that follows them, so a client that loses one has lost nothing it cannot
   * rebuild, and the mark says exactly how much of the log it is *not* behind on.
   */
  seq: number;
  data: Record<string, unknown>;
}
