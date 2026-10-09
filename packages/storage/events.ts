import type { Message } from '../protocol/index.ts';
import type { InputMode } from '../core/run-queue.ts';

/**
 * The durable session log.
 *
 * A session used to be a set of tables that each reader queried for itself: `messages` for the model's
 * history, `runs` for lifecycle, `context_checkpoints` for compaction, and so on. That worked, but it
 * meant "what happened in this session" had as many answers as there were readers, and a new durable
 * fact could be added by writing a row that no other reader would ever see. The one property that was
 * checkable only by hand was the one that matters most: *the history the model is given is the history
 * that was recorded*.
 *
 * The log makes that a fold. Every durable fact is appended as an event, and every reader derives its
 * view from the events — `foldMessages` here is the first and most important of those folds, because the
 * message projection is what the model sees, what the UI renders and what the summary compacts.
 *
 * Two rules keep it honest:
 *
 * 1. **Appending is the only way to record something.** The tables stay as the write-through store for
 *    now, but they are written *from* the same call that appends the event, in one transaction, so there
 *    is no window in which one exists without the other.
 * 2. **An unknown event type is not silently skipped.** If this build meets an event it does not know,
 *    the fold refuses rather than quietly returning a transcript that is missing content the model was
 *    shown. Types a reader may safely skip have to say so (`IGNORABLE_SESSION_EVENTS`), and a
 *    model-visible one never can.
 */
export const SESSION_EVENT_TYPES = [
  'message.user',
  'message.assistant',
  'message.tool',
  'run.started',
  'run.finished',
  'session.title.generated',
  'context.compacted',
  /**
   * A delegation: this session created a child and what that child is.
   *
   * The record is the authority that survives the process, so it carries the *descriptor* a resume needs and not
   * just the child's name: `role`, `objective`, `childSessionId` — and, when the delegation named them, `persona`
   * (who the child speaks as) and `model` (which model it answers on). Both of those belong to the delegation
   * rather than to the child's transcript, so without them a child resumed in a new process comes back as the
   * deployment's persona and the *parent's* model — a difference nobody would notice, because the resumed turn
   * looks like any other.
   *
   * Two fields of a delegation are deliberately **not** recorded, and the reasons are different:
   *
   * - the task's `context` paragraph: it only ever entered the child's first prompt, which is already in the
   *   child's own transcript, so a copy here would be a second version of a fact that has one home;
   * - the task's `outputSchema`: it shapes the *first* answer's contract, and the transcript records which
   *   contract was met by holding the answer that was accepted. A resumed child asked a follow-up is being asked
   *   a question, not handed the original task again (see `reportSchema` in the child's own options).
   *
   * `forked` marks a child that started from the parent's transcript rather than from its own work.
   */
  'subagent.assigned',
  'subagent.finished',
  'subagent.interrupted',
  /**
   * A delegated child's outcome reached its parent.
   *
   * `subagent.finished` says how a child ended; it does not say whether anyone was told. Without this the two
   * are indistinguishable from a reader's side, so a parent could not be reminded about a child it never
   * collected — and "the work is done but the parent never heard" is the failure mode this records against.
   * A `collected` id is either the delegation's task id (`collect_subagents`) or the child session id
   * (`job_output`), because the two surfaces name the same child differently; either one counts as delivery.
   */
  'subagent.collected',
  /**
   * A message the parent handed to a child: accepted first, handed over second.
   *
   * Two records rather than one, for the same reason `approval.required`/`approval.decided` are two: the
   * state between them is the one a reader needs. `queued` is written *before* the hand-off is attempted, so
   * the parent's acceptance of the message is durable before anything can be lost, and a `queued` without a
   * `handed` is exactly "the process stopped after accepting this and before the child got it" — a message
   * that has to be sent again. One record carrying both states could not express "nobody ever handed it
   * over", and what that hides is silent: the parent believes the child was corrected while it was not.
   *
   * `handed` says *how* it reached the child (`correction` folded into a turn already running, or `turn` as a
   * turn of its own), because the two differ in what the parent can expect next: the first answers inside the
   * turn that was already in flight, the second settles as a new outcome.
   *
   * Durable-only: the live channel shows what a child *says*, not what was queued for it.
   */
  'subagent.message.queued',
  'subagent.message.handed',
  'subagent.message.consumed',
  'todo.written',
  'program.call.settled',
  /**
   * A background command this session started and how it ended.
   *
   * A command is the one kind of work whose *outcome has nowhere to go*: `start_command` returns an id and the
   * run moves on, so a command that finishes after the turn that started it — or after the process that ran it —
   * was known only to the manager that held the job, which is memory. The next run in the session therefore had
   * no way to learn that the build it kicked off had failed, and the model that asked for it could not be told.
   *
   * Two records rather than one, on the same argument as `approval.required`/`approval.decided`: a `started`
   * with no `settled` is exactly "it was still running when the record ends", which is a state a reader has to
   * be able to see. `settled` carries the tail of what it printed and how much it printed in total — the
   * process's output ring is not durable, so the tail is the honest durable copy, and the total is what makes
   * the tail readable as a tail.
   *
   * `command.collected` is the delivery record, mirroring `subagent.collected`: the notice repeats until the
   * model actually reads the finished command, because announcing once and hoping is the failure this exists to
   * prevent. Not ignorable, for the same reason `subagent.assigned` is not: these are the session's own record
   * of the work it started, and the fold that decides what the model has not been told reads them.
   */
  'command.started',
  'command.settled',
  'command.collected',
  'background.policy',
  'background.pending',
  'background.admitted',
  'background.processed',
  'background.hidden',
  'task.admitted',
  'task.skipped',
  /**
   * The files the model presented as this session's deliverables, and the session's goal.
   *
   * Neither is model-visible history — the transcript is the same with or without them — but a reader that
   * skipped them would show a session whose output nobody was handed and whose objective nobody recorded,
   * which is the state a person reopens the session to check. So they are durable and *not* ignorable, on
   * the same argument `todo.written` is: the bar for `IGNORABLE_SESSION_EVENTS` below is "the absence changes
   * nothing a reader is responsible for", and both of these change exactly that.
   *
   * Each carries its whole state (a list, or one goal) rather than a delta, so the fold is a replacement and
   * a reopened session is rebuilt from the newest record instead of from a replay of edits.
   */
  'deliverable.presented',
  'goal.changed',
  /**
   * The two halves of every human decision, recorded separately and in order.
   *
   * Asked and decided are separate records because the interesting state is *between* them: a log that ends
   * with an `approval.required` and no `approval.decided` says the run was interrupted while waiting for a
   * person, which is exactly what a reopened session has to be able to tell. One record carrying the outcome
   * could not express "nobody ever answered".
   */
  'approval.required',
  'approval.decided',
  'question.required',
  'question.answered',
  /**
   * A run whose owning process disappeared, converged at startup or on the next read.
   *
   * The run's `run.started` says it began; without this, nothing says it ended, and "there is a run in flight"
   * is exactly the wrong thing to conclude from a process that no longer exists. It is durable-only: recovery
   * happens before any client is connected, so there is nobody to notify live.
   */
  'run.interrupted',
  /**
   * A scheduled moment that arrived while the Host could not start the run.
   *
   * A due task waits for the Host rather than for the clock, and until this record existed that wait was silent:
   * the row still said "due", the clock re-armed, and the only trace of the delay was a `last_run_at` later than
   * the schedule named — which cannot tell "the Host was busy" apart from "the process was down" or "somebody
   * edited the task". The scheduler writes one record per *session and due moment*, naming every task that
   * arrived then, so a session with several tasks firing together has one line rather than several to
   * cross-reference (the merge the snapshot's §4.5 asks for).
   *
   * Durable-only and not model-visible: the model is not the reader — the run that eventually starts carries the
   * task's own prompt — and the question this answers ("why was 09:00 late?") is asked by whoever reads the log.
   */
  'task.due',
  /**
   * A run's step boundaries: the round began, and the round ended for a named reason.
   *
   * `run.started` and `run.finished` bracket the whole turn, which leaves "where inside it" unanswerable: a log
   * that ends mid-run says a run was in flight, not which request it died on, and the transcript cannot say it
   * either — a step that never ended is a record that was never written. These two are that boundary, and the
   * `step.started` without a matching `step.finished` is what a reader pairs up to find the step that was open
   * when the process died. `step.finished` carries *why* it ended (`StepEndReason` in `../protocol/steps.ts`),
   * because "the model answered" and "the provider failed" are both "the step is over" and only the reason
   * separates a finished run from an abandoned one.
   *
   * Durable-only: the live channel already carries the step's own output — deltas, tool calls — and a client
   * that wants the boundary after a reload reads it here rather than being told twice while it streams.
   */
  'step.started',
  'step.finished',
  /**
   * A request the provider refused for size, and what the run did about it. The compaction checkpoint records
   * that the conversation was compressed; only this records *why*, which is the question asked later.
   */
  'context.overflow',
  /**
   * What one round asked the model to read: the system prompt and the tool catalogue it was sent with.
   *
   * The transcript was always reconstructible from this log and the *envelope* never was — the prompt and the
   * schema catalog were request fields and nothing else. So a session reopened after the workspace's `AGENTS.md`,
   * memory or skills had changed could not say what a past round had actually been made of, and a compaction
   * summary could not be audited against the request that produced it.
   *
   * It carries a digest of each part, the prompt itself on the record that first carries that digest (see
   * `ContextEnvelope` in `../protocol/context.ts` for the copy and truncation policy), and the model and limits
   * the round aimed at. Written once per round — a round is the unit a person reads the log in — and again when a
   * provider-confirmed overflow makes the round prepare a *different* envelope before re-sending.
   *
   * Not model-visible history, so the transcript fold passes over it like `llm.request`; the reader that needs it
   * is the one asking what a request contained, and it reads the events rather than the transcript.
   */
  'context.envelope',
  /**
   * The correction this session's route needs, as measured from provider-reported usage.
   *
   * The estimate is a character heuristic, and the only trustworthy measurement of how wrong it is comes from what
   * the endpoint says it billed. That measurement used to die with the run that made it: a session resumed in a new
   * process started from a factor of 1 and mis-sized its first request exactly as the previous run had, however much
   * the previous run had learned. Recorded per observed round — the payload is the factor and the sample count, so
   * a crashed run keeps what it had already learned — and read back by the next run on the *same route*, because a
   * correction is only meaningful about the model it was measured on (`calibrationRoute`).
   *
   * Durable-only: the live channel already carries both halves of it in `context.forecast` (`inputTokens` against
   * `rawInputTokens`), so a client can see the correction without a second frame saying so.
   */
  'context.calibration',
  /**
   * Which instruction files and skills this run loaded, recorded when it loaded them.
   *
   * The live frame of the same name used to be the only record of it, and a live frame is gone the moment the
   * window closes: a reader could see the *prompt* that quoted an `AGENTS.md` (once `context.envelope` existed)
   * without being able to say which files the run had chosen to load from the workspace, or which skills it had
   * offered the model. Durable with the same payload as the live event, so the two cannot describe different runs.
   */
  'resources.loaded',
  /**
   * A round's model request failed in a way that re-sending it may fix, and was re-sent.
   *
   * Recorded *before* the wait rather than after it, for two reasons: the wait can be interrupted (a Stop
   * during a 30-second backoff must not leave a retry that never happened in the log), and this record is the
   * retry counter — the next attempt counts the rows for its round, so a host that restarts between attempts
   * does not come back with a fresh allowance.
   */
  'llm.retry',
  'provider.request.finished',
  'tool.execution.started',
  'tool.execution.finished',
  'context.summary.retry',
  /**
   * Which model and effort served a round, written when either changes.
   *
   * A change log rather than one row per round: a run on its configured model writes nothing at all. It is
   * durable because "which model answered at 3am" is a question about the past, and the answer has to survive
   * the process that knew it — the live event carries the same shape for a client that wants to update what it
   * shows while the run is still going.
   */
  'llm.request',
  /**
   * The session's own input inbox: an input a person queued for a *running* session, and what became of it.
   *
   * The queue used to be memory and nothing else. `enqueue` emitted a live event and pushed onto an array that
   * the run emptied before it returned, so "queued but never delivered" — the state a crash, a cancellation or
   * a Stop button produces — left no trace at all: the log showed a conversation that simply ended, and the
   * person who had typed a follow-up had no way to learn it was never sent. Worse, nothing said a run *had*
   * accepted an input, so replaying the same session could not be assumed to produce the same conversation.
   *
   * Three records, on the same argument as `approval.required`/`approval.decided` and the sub-agent inbox:
   *
   * - `input.queued` — the acceptance, written *before* the input can be folded into a turn. It carries the
   *   input's identity, mode, text and picture count, which is everything needed to offer it again.
   * - `input.consumed` — it became a user message in this session's transcript. Written in the same
   *   transaction as that message, so there is no window in which one exists without the other.
   * - `input.discarded` — it will never be delivered (`user` cleared the queue, or the `run` it was queued for
   *   ended first), carrying why. A `queued` with neither of the other two is therefore exactly "the process
   *   stopped holding this", which is the one state a reader has to be able to recognise.
   *
   * The pictures themselves are deliberately *not* in the queued record even when the input had them: the
   * transcript's own copy is written when the input is consumed, and a second durable copy of the same base64
   * is the cost this record exists to avoid. So the record says an
   * input with two pictures was waiting, and an input that never got consumed is offered again as text with
   * its picture count, which the person re-attaches — the honest version of "this is what survived".
   */
  'input.queued',
  'input.consumed',
  'input.discarded',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
const KNOWN_EVENT_TYPES = new Set<string>(SESSION_EVENT_TYPES);
/**
 * Event types this build explicitly permits readers to skip without losing model-visible content.
 * This is a local allowlist: extending it cannot teach an older binary about a newer event type.
 *
 * The bar for membership is high: every other event declared above either carries part of the transcript or
 * describes a durable state change a reader may have to act on. `todo.written` is the second kind, not the
 * first: it is never given to the model as history, but a reader that skipped it would show a checklist the
 * model is no longer following, which is worse than refusing. The same argument covers the audit records: a
 * reader that skipped `approval.decided` would show a session where a file was written and nobody allowed it.
 * So the list is not "events nobody reads" — it is "events whose absence from a reader's view changes nothing
 * it is responsible for".
 *
 * What qualifies, then, is a whole class: records *about how a run was carried out* rather than about what was
 * said. The members below are of that class — how many attempts a round needed, which model served it, and
 * where its steps began and ended. None carries a transcript part, and the state each describes is either
 * already reflected by the outcome that followed it or recorded somewhere a reader is told to look, so a reader
 * without them shows the same conversation and the same result.
 */
export const IGNORABLE_SESSION_EVENTS: readonly string[] = [
  'tool.execution.started',
  'tool.execution.finished',
  'context.summary.retry',
  // Request measurements are diagnostic; their absence cannot change the model transcript.
  'provider.request.finished',
  /**
   * A re-sent attempt. It carries no part of the transcript and no state anybody must act on: the attempt it
   * describes was already superseded — either by the answer that followed it, or by the failure that ended the
   * run. A reader that skipped it would show the same conversation and the same outcome; the only thing it loses
   * is the explanation for why a round took longer than one request.
   */
  'llm.retry',
  /**
   * A round that did not run on the run's configured model (or effort). The transcript is unaffected: the
   * answer is stored as an answer, whoever produced it. The reader that loses something is the one asking which
   * model answered — which is why this is durable, and why the list is documented as "may skip" rather than
   * "nobody reads".
   */
  'llm.request',
  /**
   * Where a step began and why it ended. Progress, not content: the messages and tool calls the step produced
   * are in the log either way, and a reader that skipped these shows the same conversation and the same result.
   * The one reader that loses something is the one asking "which step was in flight when the process died" —
   * and that answer is also carried on the `run.interrupted` record, where a reader looking for the aftermath
   * of a crash is already reading.
   */
  'step.started',
  'step.finished',
  /**
   * A message queued for a child, its hand-off, and the child's receipt that a turn folded it in. None of them
   * carries a part of *this* session's transcript: the correction becomes a user message in the **child's**
   * transcript when it is folded in, and the parent's own conversation is the same either way. A reader that
   * skipped them shows the same conversation and the same result; the one that loses something is the one
   * answering "did that message ever reach the child?", which is exactly what `collect_subagents` reads them for.
   */
  'subagent.message.queued',
  'subagent.message.handed',
  'subagent.message.consumed',
  /**
   * This session's own inbox. Same class as the sub-agent records above and for the same reason: what the
   * transcript says is unaffected by them. A consumed input *is* a user message and is in the log as one; the
   * queue record only says the message arrived through the inbox rather than through a run that started with
   * it. A reader that skipped all three would show the same conversation — it would merely be unable to answer
   * "was anything queued that never got sent?", which is what the queue dock asks on reopen.
   */
  'input.queued',
  'input.consumed',
  'input.discarded',
];
export interface SessionEvent {
  seq: number;
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}
/**
 * One rule, in one place: whether a reader may pass over this event.
 *
 * Known types are passable because this build knows what they mean; a type in `IGNORABLE_SESSION_EVENTS` is
 * passable because the list says its absence changes nothing a reader is responsible for. Anything else is an
 * event whose *meaning* is unknown, and no reader may assume it changed nothing.
 */
function passable(event: SessionEvent): boolean {
  return KNOWN_EVENT_TYPES.has(event.type) || IGNORABLE_SESSION_EVENTS.includes(event.type);
}
/** Thrown when the log contains an event this build cannot interpret and must not skip. */
export class UnsupportedSessionEventError extends Error {
  readonly eventType: string;
  readonly seq: number;
  constructor(eventType: string, seq: number) {
    super(
      `Session log has an event this build does not know: "${eventType}" at seq ${seq}. ` +
        'Refusing to derive a transcript that would silently omit it.',
    );
    this.name = 'UnsupportedSessionEventError';
    this.eventType = eventType;
    this.seq = seq;
  }
}
export function isSessionEventType(value: string): value is SessionEventType {
  return KNOWN_EVENT_TYPES.has(value);
}
/**
 * Refuse a log that holds an event this build cannot interpret, for a reader whose answer is *derived* from it.
 *
 * `foldMessages` has always refused for the transcript, and the projection folds did not — they answered from the
 * same log with whatever the unknown event had changed ignored, which is the "plausible but incomplete" answer
 * this module's own header forbids. The rule belongs to the reader rather than to the transcript: a reader that
 * derives state refuses, while the raw log stays readable, because diagnosing a session written by a newer build
 * is exactly when somebody needs to look at it.
 *
 * Called once per loaded log rather than per fold, and over the whole log rather than the range a checkpoint
 * leaves: a projection that resumes from a checkpoint written by a build that *knew* the newer type would
 * otherwise never see it (see `SessionStore.checkedLog`).
 */
export function assertKnownEvents(events: readonly SessionEvent[]): void {
  for (const event of events)
    if (!passable(event)) throw new UnsupportedSessionEventError(event.type, event.seq);
}
/**
 * The durable events that describe *what the run did and who decided it*, as opposed to what was said.
 *
 * They are the ones a reader turns into a process record: approvals asked and answered, questions asked and
 * answered, and the requests a provider refused for size. Deliberately a subset rather than "everything that
 * is not a message": `run.started`, `todo.written` and the sub-agent lifecycle have their own projections and
 * their own panels, and mixing them here would produce a list that is neither.
 */
export const AUDIT_SESSION_EVENTS = [
  'approval.required',
  'approval.decided',
  'question.required',
  'question.answered',
  'context.overflow',
  // An interrupted run belongs in the process record for the same reason an approval does: it is a fact about
  // the session that the transcript cannot carry, and it is the first thing a person needs to see after a crash.
  'run.interrupted',
] as const;
export type AuditSessionEventType = (typeof AUDIT_SESSION_EVENTS)[number];
const AUDIT_EVENT_TYPES = new Set<string>(AUDIT_SESSION_EVENTS);
/**
 * Read a slice of the process record out of the log.
 *
 * `limit` is required rather than optional because this is a cursor read: the caller asks for a bounded page
 * and gets the sequence number to continue from, which is what keeps a long session's record from being read
 * whole just to render its newest lines.
 */
export function auditEntries(events: readonly SessionEvent[], limit: number): SessionEvent[] {
  const entries: SessionEvent[] = [];
  for (const event of events) {
    if (!AUDIT_EVENT_TYPES.has(event.type)) continue;
    entries.push(event);
    if (entries.length >= limit) break;
  }
  return entries;
}
/** The event type a message is recorded as. Its role is the whole distinction. */
export function messageEventType(message: Message): SessionEventType {
  return message.role === 'user'
    ? 'message.user'
    : message.role === 'assistant'
      ? 'message.assistant'
      : 'message.tool';
}
function messageOf(event: SessionEvent): Message {
  const message = event.data.message;
  if (!message || typeof message !== 'object' || Array.isArray(message))
    throw new Error(
      `Session log event ${event.type} at seq ${event.seq} has no message payload; the log is corrupt`,
    );
  const record = message as Record<string, unknown>;
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const callsUsable = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (call) =>
        object(call) &&
        typeof call.id === 'string' &&
        typeof call.name === 'string' &&
        // Arguments are a keyed object or absent, never an array: a reader indexes into them by field name, and an
        // array would put the call's shape in doubt without ever looking wrong.
        (call.arguments === undefined || object(call.arguments)),
    );
  const valid =
    typeof record.content === 'string' &&
    ((event.type === 'message.user' && record.role === 'user') ||
      (event.type === 'message.assistant' &&
        record.role === 'assistant' &&
        callsUsable(record.toolCalls)) ||
      (event.type === 'message.tool' &&
        record.role === 'tool' &&
        typeof record.toolCallId === 'string' &&
        typeof record.isError === 'boolean'));
  if (!valid)
    throw new Error(
      `Session log event ${event.type} at seq ${event.seq} has an invalid message payload; the log is corrupt`,
    );
  return message as Message;
}
/**
 * The message projection: fold the log into the transcript.
 *
 * This is the projection the whole "model-visible ⇒ recorded" property rests on, so it is deliberately
 * total and loud: a known message event contributes, a known non-message event is passed over, and an
 * unknown event stops the fold unless it is declared ignorable.
 */
export function foldMessages(events: readonly SessionEvent[]): Message[] {
  return appendFoldedMessages([], events);
}
/**
 * Fold later events into a transcript that was already folded from an earlier prefix of the same log.
 *
 * The fold is append-only — every event either contributes a message to the end or is passed over — so
 * extending a transcript and folding the whole log are the same function of the same rule. That is what
 * lets the store keep a transcript across appends instead of re-deriving it on every read, without a
 * second implementation of "what is model-visible" that could drift from this one.
 */
export function appendFoldedMessages(
  messages: Message[],
  events: readonly SessionEvent[],
): Message[] {
  for (const event of events) {
    if (
      event.type === 'message.user' ||
      event.type === 'message.assistant' ||
      event.type === 'message.tool'
    )
      messages.push(messageOf(event));
    else if (!passable(event)) throw new UnsupportedSessionEventError(event.type, event.seq);
  }
  return messages;
}
/** One input that was accepted for a running session and has not been settled yet. */
export interface PendingSessionInput {
  id: string;
  mode: InputMode;
  prompt: string;
  createdAt: string;
  /**
   * How many pictures the input carried.
   *
   * The count, not the pictures: a queued input's bytes live in the queue, and the transcript's copy is
   * written when it is consumed (see the note on `input.queued` above). An input recovered after a crash
   * therefore knows it had pictures and no longer has them, which is what a person has to be told.
   */
  imageCount: number;
}
/** The three records the inbox fold reads, and nothing else, so the fold stays cheap on a long session. */
const INPUT_EVENT_TYPES = new Set<string>(['input.queued', 'input.consumed', 'input.discarded']);
function queuedInputOf(event: SessionEvent): PendingSessionInput {
  const item = event.data.item as Partial<PendingSessionInput> | undefined;
  if (
    !item ||
    typeof item !== 'object' ||
    typeof item.id !== 'string' ||
    (item.mode !== 'steer' && item.mode !== 'follow-up') ||
    typeof item.prompt !== 'string' ||
    typeof item.createdAt !== 'string'
  )
    throw new Error(
      `Session log event input.queued at seq ${event.seq} has no usable input payload; the log is corrupt`,
    );
  return {
    id: item.id,
    mode: item.mode,
    prompt: item.prompt,
    createdAt: item.createdAt,
    imageCount: Number(item.imageCount ?? 0),
  };
}
/** The ids a settling record names: one when it names one, several when a clear dropped a whole queue. */
function settledInputIds(event: SessionEvent): string[] {
  const ids = event.data.ids;
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  return typeof event.data.id === 'string' ? [event.data.id] : [];
}
/**
 * The inbox projection: which queued inputs nobody ever folded into a turn.
 *
 * This is the read side of the durable queue, and it is what makes a crash audible. A run that ends normally
 * settles every input it holds — consumed, or discarded with a reason — so the surviving set is the state a
 * process left behind when it stopped without settling them, which is the only thing "the queue" can mean to a
 * reader who was not there. Order is the order they were queued in, because that is the order a person
 * expects them offered back.
 */
export function foldPendingInputs(events: readonly SessionEvent[]): PendingSessionInput[] {
  const pending = new Map<string, PendingSessionInput>();
  for (const event of events) {
    if (!INPUT_EVENT_TYPES.has(event.type)) continue;
    if (event.type === 'input.queued') {
      const item = queuedInputOf(event);
      pending.delete(item.id);
      pending.set(item.id, item);
      continue;
    }
    for (const id of settledInputIds(event)) pending.delete(id);
  }
  return [...pending.values()];
}
