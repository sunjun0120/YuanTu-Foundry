import type {
  AgentEvent,
  FileChange,
  Message,
  SubAgentRole,
  SubAgentSummaryReport,
  Usage,
} from '../protocol/index.ts';
import type { CompletionRecord } from '../protocol/completion.ts';
import type { ToolResultOutput } from '../protocol/tool-result.ts';
import type { ContextBreakdown } from '../core/budget.ts';
import type { SessionSnapshot, SubAgentView } from './session-view.ts';

/**
 * The parts of a live event that turn into a piece of session state.
 *
 * `SessionController.onEvent` decides *whether* a frame applies and what to publish; these functions only say what
 * the frame means. Each is a fold of one frame onto the state it replaces, so a live window and a reloaded one agree.
 */

type EventData = AgentEvent['data'];

/**
 * The definition a window shows before it has read one.
 *
 * A `completion.updated` record written by a mid-run round carries the evidence but not the contract, so a window
 * that attached while a run was already repairing folds its first record without an objective. This stands in so
 * the shape is stable and the reader can tell "not read yet" from "no contract" — the latter being `null` on the
 * state itself. It is never written back to the session.
 */
const EMPTY_COMPLETION_DEFINITION: CompletionRecord['definition'] = {
  version: 1,
  objective: '',
  constraints: [],
  steps: [],
  acceptance: [],
  inputs: [],
};

/**
 * The round's own prediction, kept so a window can show what the request costs before it is sent and
 * after it is: "the request is too big" is not actionable on its own, and "the tool schemas cost more
 * than the conversation" is. Only the fields the panel renders are copied — the event also carries
 * numbers the run used to size the request, and a second full copy of them in the snapshot would be a
 * second answer to "what did this round cost".
 */
export function foldForecast(data: EventData): SessionSnapshot['budget'] {
  return {
    round: Number(data.round ?? 0),
    breakdown: structuredClone(data.breakdown as ContextBreakdown),
    inputTokens: Number(data.inputTokens ?? 0),
    rawInputTokens: Number(data.rawInputTokens ?? 0),
    windowRoom: Number(data.windowRoom ?? 0),
    shortened: Number(data.shortened ?? 0),
    freedChars: Number(data.freedChars ?? 0),
    compacted: data.compacted === true,
    ...(data.problem === undefined ? {} : { problem: String(data.problem) }),
    ...(data.policyProblem === undefined ? {} : { policyProblem: String(data.policyProblem) }),
  };
}

/** The transcript message a `tool.finished` frame stands for. */
export function toolResultMessage(data: EventData): Message {
  return {
    role: 'tool',
    toolCallId: String(data.callId),
    content: String(data.content),
    isError: data.isError === true,
    ...(data.change ? { change: structuredClone(data.change as FileChange) } : {}),
    /**
     * The structured payload and its renderer name, when the tool declared an output contract.
     *
     * Carried on the message rather than looked up from the tool catalogue, because no method ships that
     * catalogue to a carrier and a message has to be readable on its own: a window folding a session out
     * of the log sees results from runs whose tools an extension may since have unregistered, and a card
     * that needed the declaration to draw a two-minute-old result would draw nothing after a reload. The
     * event already carries it — the run emits the whole result — so this is the projection's job and
     * nothing upstream needs to know about it.
     *
     * The name is not re-checked against the closed set here. A client that dropped a name it did not
     * recognise would turn a defect in a tool into a missing feature in the interface, and afterwards the
     * two are indistinguishable; the set is enforced where names are written (the `ToolRenderer` type,
     * plus the test that reads every declaration back), and a carrier that meets an unknown name falls
     * back to the text it already has — which is also what it does when `output` is absent.
     */
    ...(data.output ? { output: structuredClone(data.output as ToolResultOutput) } : {}),
  };
}

/**
 * The contract's state, folded rather than merged.
 *
 * Every record the runtime writes carries a whole `summary`, so the newest one is the current state and no
 * client has to replay a sequence. The *definition* is the exception and is deliberately kept: only the
 * record written when a contract is created carries it, and a later round record without one must not erase
 * the objective and criteria the user is reading. `steps` replaces only when present, for the same reason.
 *
 * `undefined` means the frame carries nothing to fold and the current record stands.
 */
export function foldCompletion(
  previous: CompletionRecord | null,
  event: AgentEvent,
  sessionId: string | null,
): CompletionRecord | undefined {
  const data = event.data;
  const summary = data.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined;
  const definition = data.definition;
  const steps = data.steps;
  const affectedPaths = data.affectedPaths;
  const contractId = String(data.contractId ?? previous?.contractId ?? '');
  if (!contractId) return undefined;
  if (previous?.contractId !== contractId) previous = null;
  return {
    version: 1,
    contractId,
    sessionId: sessionId ?? '',
    originRunId: String(data.runId ?? previous?.originRunId ?? event.runId ?? ''),
    latestRunId: String(data.runId ?? event.runId ?? previous?.latestRunId ?? ''),
    source:
      data.source === 'task' ||
      data.source === 'request' ||
      data.source === 'approved-plan' ||
      data.source === 'automatic'
        ? data.source
        : (previous?.source ?? 'request'),
    definition:
      definition && typeof definition === 'object' && !Array.isArray(definition)
        ? structuredClone(definition as CompletionRecord['definition'])
        : (previous?.definition ?? EMPTY_COMPLETION_DEFINITION),
    definitionHash: String(
      (summary as { definitionHash?: unknown }).definitionHash ?? previous?.definitionHash ?? '',
    ),
    summary: structuredClone(summary as CompletionRecord['summary']),
    ...(data.evidence && typeof data.evidence === 'object'
      ? { evidence: structuredClone(data.evidence as CompletionRecord['evidence']) }
      : previous?.evidence
        ? { evidence: previous.evidence }
        : {}),
    steps: Array.isArray(steps)
      ? structuredClone(steps as CompletionRecord['steps'])
      : (previous?.steps ?? []),
    affectedPaths: Array.isArray(affectedPaths)
      ? affectedPaths.map(String)
      : (previous?.affectedPaths ?? []),
    policy:
      data.policy && typeof data.policy === 'object'
        ? structuredClone(data.policy as CompletionRecord['policy'])
        : (previous?.policy ?? {
            maxRepairRounds: 0,
            maxRepeatedFailures: 0,
            repairTimeoutMs: 0,
          }),
    ...(typeof data.repairStartedAt === 'number'
      ? { repairStartedAt: data.repairStartedAt }
      : previous?.repairStartedAt === undefined
        ? {}
        : { repairStartedAt: previous.repairStartedAt }),
    ...(typeof data.failureFingerprint === 'string'
      ? { failureFingerprint: data.failureFingerprint }
      : previous?.failureFingerprint === undefined
        ? {}
        : { failureFingerprint: previous.failureFingerprint }),
    ...(typeof data.taskId === 'string'
      ? { taskId: data.taskId }
      : previous?.taskId === undefined
        ? {}
        : { taskId: previous.taskId }),
    ...(typeof data.planId === 'string'
      ? { planId: data.planId }
      : previous?.planId === undefined
        ? {}
        : { planId: previous.planId }),
    ...(typeof data.goalObjective === 'string'
      ? { goalObjective: data.goalObjective }
      : previous?.goalObjective === undefined
        ? {}
        : { goalObjective: previous.goalObjective }),
  };
}

/** The card a `subagent.started` frame opens. */
export function startedSubAgent(data: EventData): SubAgentView {
  return {
    id: String(data.id),
    index: Number(data.index),
    total: Number(data.total),
    role: data.role as SubAgentRole,
    objective: String(data.objective),
    childSessionId: String(data.childSessionId),
    status: 'running',
    rounds: 0,
    toolCalls: 0,
    // The clock starts with the child's first frame rather than here: this event says a session exists,
    // and the turn it will run has not begun. A row that ticked from this moment would count the
    // provider setup as work.
    durationMs: 0,
    runningSince: null,
    text: '',
  };
}

/** A child's tool starting or finishing, folded onto its card. */
export function foldSubAgentTool(view: SubAgentView, data: EventData): void {
  if (data.phase === 'started') {
    view.tool = String(data.name);
    if (typeof data.args === 'string' && data.args) view.toolArgs = data.args;
  } else {
    view.tool = undefined;
    view.toolArgs = undefined;
    view.toolCalls++;
  }
}

/** A child's clock and usage, folded onto its card. */
export function foldSubAgentProgress(view: SubAgentView, data: EventData): void {
  view.durationMs = Number(data.durationMs ?? view.durationMs ?? 0);
  view.runningSince =
    data.runningSince === null || data.runningSince === undefined
      ? null
      : Number(data.runningSince);
  if (data.usage) view.usage = data.usage as Usage;
}

/** How far a child's result export has got, folded onto its card. */
export function foldSubAgentWorkspaceProgress(view: SubAgentView, data: EventData): void {
  const processed = Number(data.processed);
  const total = Number(data.total);
  if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || total < 0) return;
  view.workspaceProgress = { processed: Math.min(Math.max(processed, 0), total), total };
}

/** Where a child worked and what it produced, as a `subagent.workspace` frame states it. */
export function subAgentWorkspace(data: EventData): NonNullable<SubAgentView['workspace']> {
  return {
    kind: data.kind as 'shared' | 'worktree',
    executionRoot: String(data.executionRoot),
    state: String(data.state),
    ...(typeof data.dependencyWarning === 'string'
      ? { dependencyWarning: data.dependencyWarning }
      : {}),
    ...(data.result
      ? { result: data.result as NonNullable<SubAgentView['workspace']>['result'] }
      : {}),
  };
}

/** A child's turn ending, folded onto its card. */
export function foldSubAgentFinished(view: SubAgentView, data: EventData): void {
  view.status = data.status as SubAgentView['status'];
  delete view.workspaceProgress;
  view.rounds = Number(data.rounds ?? view.rounds);
  view.toolCalls = Number(data.toolCalls ?? view.toolCalls);
  if (data.usage) view.usage = data.usage as Usage;
  // The turn's clock has stopped: the settled total the host read out of the child's log is what the
  // card keeps, and it must not be re-derived from a `runningSince` that outlived its own turn.
  view.durationMs = Number(data.durationMs ?? view.durationMs ?? 0);
  view.runningSince = null;
  view.tool = undefined;
  view.toolArgs = undefined;
  if (data.report) view.report = data.report as SubAgentSummaryReport;
  if (typeof data.text === 'string' && data.text) view.text = data.text;
  if (typeof data.error === 'string' && data.error) view.error = data.error;
}
