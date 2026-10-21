/**
 * What a carrier asks of the service, and what the service tells a carrier.
 *
 * This file used to live in `apps/desktop/`: the command vocabulary and the state the interface renders were
 * written as if the Electron window were the only thing that would ever consume them. Nothing here needs a
 * window — the commands are validated protocol-level intents and the snapshot is built from Host answers — so
 * it moved down with the service. What stays in
 * `apps/desktop/contract.ts` is the Electron IPC bridge, which is shell-specific by definition.
 */
import type {
  SessionSnapshot,
  MessageDelta,
  SubAgentDelta,
  SubAgentView,
  StatisticsDelta,
} from '../client/session-controller.ts';
export type { MessageDelta, SubAgentDelta, StatisticsDelta };
import type { FileEffect, NetworkEffect } from '../protocol/execution.ts';
import type { HostStatus } from '../client/host-client.ts';
import type {
  SessionInfo,
  Task,
  TaskAttempt,
  TaskStep,
  TaskStepCheckpoint,
  TaskTrigger,
  Acceptance,
  Message,
  QuestionAnswer,
  SessionEventView,
} from '../protocol/index.ts';
import type { ImageAttachment } from '../protocol/index.ts';
import type { HostMethods } from '../protocol/rpc.ts';
import type { PlanVerification, RunVerification } from '../protocol/completion.ts';
export type { PlanVerification, RunVerification } from '../protocol/completion.ts';
import type { Language } from '../protocol/language.ts';
import type { SandboxMode } from '../tools/sandbox-provider.ts';
import { parseSandboxMode } from '../tools/sandbox-mode.ts';
import { normalizeTaskDraft } from '../protocol/task-spec.ts';
import { normalizeTaskTrigger } from '../protocol/task-trigger.ts';
import { validateUserInput } from '../protocol/images.ts';

/**
 * Every intent a carrier can express.
 *
 * The list is deliberately one vocabulary rather than "carrier commands plus shell commands": a shell may
 * intercept `copyText`, `openLink`, `export` and `chooseWorkspace` before they reach the service (they are
 * window concerns — a clipboard, an external browser, a save dialog, a folder picker), but the *shape* of
 * those intents is the same for every carrier, and validating them in one place is what keeps a second
 * carrier from inventing a second parser.
 */
export type CarrierCommand =
  | { type: 'export'; content: string; suggestedName: string }
  | {
      type:
        | 'snapshot'
        | 'create'
        | 'cancel'
        | 'chooseWorkspace'
        | 'clearQueue'
        | 'refreshResources'
        | 'refreshBackground'
        | 'clearBackground'
        | 'compact'
        | 'loadOlder';
    }
  | { type: 'stopBackground'; id: string; sessionId: string }
  | {
      type: 'backgroundPolicy';
      policy: HostMethods['background.policy']['params']['policy'];
      reset?: boolean;
    }
  | { type: 'pollBackground'; id: string; sessionId: string; cursor: number }
  /**
   * Confine this carrier's commands to one sandbox mode, from the next command on.
   *
   * A carrier is one Host process serving many sessions, and the mode it enforces is a process-wide fact read
   * per command — so "which sandbox is this session in" is a question only the caller can answer, and this is
   * how the caller answers it. Nothing restarts, which is the point: the desktop used to move the sandbox by
   * spawning a new Host, and that made a per-session choice cost a process.
   */
  | { type: 'sandbox'; mode: SandboxMode; files?: FileEffect; network?: NetworkEffect }
  | {
      type: 'taskSave';
      taskId: string;
      title: string;
      description: string;
      steps: TaskStep[];
      acceptance: Acceptance[];
      expectedUpdatedAt: string;
    }
  | { type: 'taskStart' | 'taskPropose'; taskId: string }
  | { type: 'taskTrigger'; taskId: string; trigger: TaskTrigger | null }
  | { type: 'taskApproval'; taskId: string; approvalId: string; allow: boolean }
  | { type: 'taskConfirm'; taskId: string; indices: number[]; expectedUpdatedAt: string }
  | { type: 'taskRefresh' }
  | { type: 'taskVerify'; taskId: string }
  | { type: 'taskRetry'; taskId: string; prompt?: string }
  | { type: 'taskHistory'; taskId: string }
  | {
      type: 'goal' | 'plan';
      prompt: string;
      /**
       * The interface language the draft is written in.
       *
       * A draft's default steps are generated content, not dictionary copy — they land in the fields the person
       * edits — so the carrier, which is the side that knows what language the window is showing, has to say which
       * one to write. Absent keeps the Chinese wording older clients have always received.
       */
      language?: Language;
    }
  | { type: 'planApprove'; planId: string; hash: string }
  | { type: 'planReject'; planId: string; reason?: string }
  | { type: 'planExecute'; planId: string; verification?: PlanVerification }
  | { type: 'planRefresh' }
  | { type: 'load' | 'undo' | 'deleteSession'; id: string }
  | { type: 'rename'; id: string; title: string }
  /** Take a session out of the sidebar's list (`archived: true`) or bring it back. */
  | { type: 'archiveSession'; id: string; archived: boolean }
  | { type: 'searchSessions'; query: string }
  /** Show the next page of older sessions in the list. */
  | { type: 'loadMoreSessions' }
  | { type: 'copyText'; text: string }
  | { type: 'openLink'; url: string }
  | { type: 'send'; prompt: string; images?: ImageAttachment[]; verification?: RunVerification }
  | { type: 'enqueue'; prompt: string; images?: ImageAttachment[]; mode: 'steer' | 'follow-up' }
  | {
      type: 'approve';
      id: string;
      allow: boolean;
      /**
       * Allow this exact request for the rest of the session.
       *
       * The approval list offers it for command approvals: a test command an agent retries five times used to
       * cost five identical clicks. "Exact" is the tool call's name and arguments, compared byte for byte, so a
       * different command is still a new decision.
       */
      remember?: boolean;
    }
  | { type: 'questionAnswer'; id: string; answers?: QuestionAnswer[]; cancelled?: boolean }
  | { type: 'subagentTranscript'; subagentId: string; childSessionId: string }
  | {
      type: 'subagentWorkspace';
      subagentId: string;
      childSessionId: string;
      action: 'archive' | 'remove' | 'restore';
    }
  | { type: 'closeSubagentTranscript' };
/**
 * A sub-agent's transcript, opened from its card. It is read-only by construction: the panel shows
 * stored messages and offers no way to send, rename or undo inside a child run.
 */
export interface SubAgentTranscript {
  subagentId: string;
  childSessionId: string;
  objective: string;
  status: SubAgentView['status'];
  report?: SubAgentView['report'];
  error?: string;
  messages: Message[];
  /** True when the transcript was longer than the viewer's page budget. */
  truncated: boolean;
}
export type { CarrierIssue } from './errors.ts';
export interface CarrierSnapshot {
  sessionQuery?: string;
  currentSession?: SessionInfo | null;
  changes: HostMethods['changes.list']['result'];
  /**
   * Set when the app brought itself back after the Host process died, so the window can explain what happened
   * instead of looking like nothing did. Structured rather than a sentence: the main process does not localise.
   * `pid` is the process that died — a report that says which process is what makes it correlatable.
   *
   * A carrier that was handed a link to somebody else's Host has no process of its own to restart, so it
   * reports the failure and leaves `recovery` null (see `CarrierService`).
   */
  recovery: { attempts: number; pid: number | null } | null;
  /**
   * The session's process record, straight from the durable log: approvals and questions with their answers,
   * and the requests the provider refused for size. It is what a reopened session can still show about what
   * happened, as opposed to what was said.
   */
  audit: SessionEventView[];
  startupStage: 'starting' | 'resources' | 'history' | 'ready' | 'failed' | 'stopped';
  resources: HostMethods['resources.list']['result'];
  workspace: string;
  model: string;
  configured: boolean;
  supportsVision: boolean;
  ready: boolean;
  host: HostStatus;
  /**
   * The Host process's id while one is running, or null.
   *
   * `host` says what the transport thinks; this says *which process* it was talking to, which is what a failure
   * report needs in order to name the process that died. A carrier that did not start the Host reports null,
   * because the process is not its to name.
   */
  hostPid: number | null;
  sessions: SessionInfo[];
  /** Whether older sessions exist beyond `sessions`; optional for older callers, absent means no. */
  sessionsHasMore?: boolean;
  background: HostMethods['background.list']['result'];
  backgroundState?: HostMethods['background.state']['result'] | null;
  tasks: Task[];
  taskAttempts: Record<string, TaskAttempt[]>;
  taskSteps: Record<string, TaskStepCheckpoint[]>;
  session: SessionSnapshot;
  subagentTranscript: SubAgentTranscript | null;
  error: string | null;
  /** Optional for older callers; the shell translates this instead of matching rendered strings. */
  errorDetail?: import('./errors.ts').CarrierIssue | null;
}
const VERIFICATION_LIMITS = {
  acceptance: 32,
  inputs: 256,
  constraints: 32,
  pathChars: 4096,
} as const;
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringList(value: unknown, max: number, chars: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === 'string' && item.length <= chars)
  );
}
function repairPolicyEnvelope(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      ['maxRepairRounds', 'maxRepeatedFailures', 'repairTimeoutMs'].includes(key) &&
      Number.isSafeInteger(item) &&
      (item as number) >= 0,
  );
}
function acceptanceEnvelope(value: unknown): value is Acceptance[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= VERIFICATION_LIMITS.acceptance &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.description === 'string' &&
        typeof item.met === 'boolean' &&
        (item.check === undefined || isRecord(item.check)),
    )
  );
}
function runVerificationEnvelope(value: unknown): value is RunVerification {
  if (!isRecord(value) || !repairPolicyEnvelope(value.repairPolicy)) return false;
  const keys = Object.keys(value).filter((key) => key !== 'repairPolicy');
  if (keys.length !== 1) return false;
  if (keys[0] === 'resumeCompletionId')
    return (
      typeof value.resumeCompletionId === 'string' &&
      !!value.resumeCompletionId.trim() &&
      value.resumeCompletionId.length <= 256
    );
  if (keys[0] !== 'completion' || !isRecord(value.completion)) return false;
  const spec = value.completion;
  return (
    typeof spec.objective === 'string' &&
    !!spec.objective.trim() &&
    acceptanceEnvelope(spec.acceptance) &&
    (spec.inputs === undefined ||
      stringList(spec.inputs, VERIFICATION_LIMITS.inputs, VERIFICATION_LIMITS.pathChars)) &&
    (spec.constraints === undefined ||
      stringList(spec.constraints, VERIFICATION_LIMITS.constraints, 2000)) &&
    (spec.steps === undefined || Array.isArray(spec.steps))
  );
}
function planVerificationEnvelope(value: unknown): value is PlanVerification {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['acceptance', 'inputs', 'constraints', 'repairPolicy'].includes(key),
    ) &&
    acceptanceEnvelope(value.acceptance) &&
    (value.inputs === undefined ||
      stringList(value.inputs, VERIFICATION_LIMITS.inputs, VERIFICATION_LIMITS.pathChars)) &&
    (value.constraints === undefined ||
      stringList(value.constraints, VERIFICATION_LIMITS.constraints, 2000)) &&
    repairPolicyEnvelope(value.repairPolicy)
  );
}
export function parseCarrierCommand(input: unknown): CarrierCommand {
  const invalid = () => {
    throw new Error('Invalid carrier command');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    snapshot: ['type'],
    create: ['type'],
    cancel: ['type'],
    chooseWorkspace: ['type'],
    clearQueue: ['type'],
    refreshResources: ['type'],
    planRefresh: ['type'],
    planApprove: ['type', 'planId', 'hash'],
    planReject: ['type', 'planId'],
    planExecute: ['type', 'planId', 'verification'],
    refreshBackground: ['type'],
    clearBackground: ['type'],
    backgroundPolicy: ['type', 'policy', 'reset'],
    stopBackground: ['type', 'id', 'sessionId'],
    pollBackground: ['type', 'id', 'sessionId', 'cursor'],
    sandbox: ['type', 'mode', 'files', 'network'],
    compact: ['type'],
    loadOlder: ['type'],
    taskSave: [
      'type',
      'taskId',
      'title',
      'description',
      'steps',
      'acceptance',
      'expectedUpdatedAt',
    ],
    taskStart: ['type', 'taskId'],
    taskPropose: ['type', 'taskId'],
    taskTrigger: ['type', 'taskId', 'trigger'],
    taskApproval: ['type', 'taskId', 'approvalId', 'allow'],
    taskConfirm: ['type', 'taskId', 'indices', 'expectedUpdatedAt'],
    taskRefresh: ['type'],
    taskVerify: ['type', 'taskId'],
    taskRetry: ['type', 'taskId', 'prompt'],
    taskHistory: ['type', 'taskId'],
    export: ['type', 'content', 'suggestedName'],
    goal: ['type', 'prompt', 'language'],
    plan: ['type', 'prompt', 'language'],
    copyText: ['type', 'text'],
    openLink: ['type', 'url'],
    load: ['type', 'id'],
    rename: ['type', 'id', 'title'],
    deleteSession: ['type', 'id'],
    archiveSession: ['type', 'id', 'archived'],
    searchSessions: ['type', 'query'],
    loadMoreSessions: ['type'],
    undo: ['type', 'id'],
    send: ['type', 'prompt', 'images', 'verification'],
    enqueue: ['type', 'prompt', 'images', 'mode'],
    approve: ['type', 'id', 'allow', 'remember'],
    questionAnswer: ['type', 'id', 'answers', 'cancelled'],
    subagentTranscript: ['type', 'subagentId', 'childSessionId'],
    subagentWorkspace: ['type', 'subagentId', 'childSessionId', 'action'],
    closeSubagentTranscript: ['type'],
  };
  if (typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)) return invalid();
  if (Object.keys(value).some((key) => !fields[value.type as string]!.includes(key)))
    return invalid();
  if (
    (value.type === 'goal' || value.type === 'plan') &&
    value.language !== undefined &&
    value.language !== 'zh-CN' &&
    value.language !== 'en-US'
  )
    return invalid();
  if (value.type === 'taskSave') {
    if (typeof value.taskId !== 'string' || !value.taskId.trim() || value.taskId.length > 256)
      return invalid();
    if (typeof value.expectedUpdatedAt !== 'string') return invalid();
    const definition = normalizeTaskDraft(value);
    return {
      type: 'taskSave',
      taskId: String(value.taskId),
      expectedUpdatedAt: value.expectedUpdatedAt,
      ...definition,
    };
  }
  if (value.type === 'backgroundPolicy') {
    const p = value.policy as Record<string, unknown> | null;
    if (
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => !['mode', 'paused', 'maxWakeups', 'maxRunMs'].includes(k)) ||
      !['notify', 'auto'].includes(String(p.mode)) ||
      typeof p.paused !== 'boolean' ||
      !Number.isSafeInteger(p.maxWakeups) ||
      Number(p.maxWakeups) < 1 ||
      Number(p.maxWakeups) > 20 ||
      !Number.isSafeInteger(p.maxRunMs) ||
      Number(p.maxRunMs) < 1000 ||
      Number(p.maxRunMs) > 300000 ||
      (value.reset !== undefined && typeof value.reset !== 'boolean')
    )
      return invalid();
    return {
      type: 'backgroundPolicy',
      policy: p as unknown as HostMethods['background.policy']['params']['policy'],
      ...(value.reset === undefined ? {} : { reset: value.reset as boolean }),
    };
  }
  if (
    value.type === 'taskConfirm' &&
    (typeof value.expectedUpdatedAt !== 'string' ||
      !Array.isArray(value.indices) ||
      !value.indices.length ||
      value.indices.length > 64 ||
      value.indices.some((i) => !Number.isInteger(i) || i < 0))
  )
    return invalid();
  if (
    ['load', 'approve', 'undo', 'rename', 'deleteSession', 'archiveSession'].includes(
      String(value.type),
    )
  ) {
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) return invalid();
  }
  if (value.type === 'archiveSession' && typeof value.archived !== 'boolean') return invalid();
  if (value.type === 'sandbox' && (value.mode === 'docker' || value.mode === 'sbx'))
    parseSandboxMode(value.mode);
  // The vocabulary is the sandbox seam's, so an unknown backend is refused here rather than at the far end of
  // the wire — where the answer would be a Host that kept enforcing the old mode while the caller believed
  // otherwise.
  if (
    value.type === 'sandbox' &&
    value.mode !== 'host' &&
    value.mode !== 'native' &&
    value.mode !== 'seatbelt' &&
    value.mode !== 'windows'
  )
    return invalid();
  if (
    value.type === 'sandbox' &&
    value.files !== undefined &&
    value.files !== 'read-only' &&
    value.files !== 'workspace-write'
  )
    return invalid();
  if (
    value.type === 'sandbox' &&
    value.network !== undefined &&
    value.network !== 'denied' &&
    value.network !== 'unrestricted'
  )
    return invalid();
  if (
    [
      'taskVerify',
      'taskRetry',
      'taskHistory',
      'taskSave',
      'taskStart',
      'taskPropose',
      'taskTrigger',
      'taskApproval',
      'taskConfirm',
    ].includes(String(value.type))
  ) {
    if (typeof value.taskId !== 'string' || !value.taskId.trim() || value.taskId.length > 256)
      return invalid();
    if (
      value.type === 'taskRetry' &&
      value.prompt !== undefined &&
      (typeof value.prompt !== 'string' || value.prompt.length > 100_000)
    )
      return invalid();
  }
  if (value.type === 'taskTrigger') {
    // Normalize here so the renderer can only ever send a schedule the scheduler understands.
    if (
      value.trigger !== null &&
      (typeof value.trigger !== 'object' || Array.isArray(value.trigger))
    )
      return invalid();
    try {
      const trigger = normalizeTaskTrigger(value.trigger);
      // Saving owns delay anchoring. Validation must leave an omitted anchor omitted so the
      // Store can preserve an unchanged rule rather than restart its countdown on every save.
      if (
        trigger?.kind === 'after' &&
        (value.trigger as Record<string, unknown>).anchorAt === undefined
      )
        delete trigger.anchorAt;
      return {
        type: 'taskTrigger',
        taskId: String(value.taskId),
        trigger: trigger ?? null,
      };
    } catch {
      return invalid();
    }
  }
  if (
    ['stopBackground', 'pollBackground'].includes(String(value.type)) &&
    (typeof value.id !== 'string' ||
      !value.id.trim() ||
      value.id.length > 128 ||
      typeof value.sessionId !== 'string' ||
      !value.sessionId.trim() ||
      value.sessionId.length > 256)
  )
    return invalid();
  if (
    value.type === 'pollBackground' &&
    (typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor) || value.cursor < 0)
  )
    return invalid();
  if (
    value.type === 'copyText' &&
    (typeof value.text !== 'string' || value.text.length > 1_000_000)
  )
    return invalid();
  if (
    value.type === 'export' &&
    (typeof value.content !== 'string' ||
      value.content.length > 5_000_000 ||
      (value.suggestedName !== undefined &&
        (typeof value.suggestedName !== 'string' || value.suggestedName.length > 120)))
  )
    return invalid();
  if (value.type === 'openLink') {
    if (typeof value.url !== 'string' || value.url.length > 4096 || /[\x00-\x20]/.test(value.url))
      return invalid();
    try {
      const url = new URL(value.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        return invalid();
    } catch {
      return invalid();
    }
  }
  if (
    (value.type === 'send' ||
      value.type === 'enqueue' ||
      value.type === 'goal' ||
      value.type === 'plan') &&
    (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 100_000)
  )
    return invalid();
  if (value.type === 'enqueue' && value.mode !== 'steer' && value.mode !== 'follow-up')
    return invalid();
  if (
    value.type === 'send' &&
    value.verification !== undefined &&
    !runVerificationEnvelope(value.verification)
  )
    return invalid();
  if (
    value.type === 'planExecute' &&
    value.verification !== undefined &&
    !planVerificationEnvelope(value.verification)
  )
    return invalid();
  if (value.type === 'send' || value.type === 'enqueue') {
    try {
      validateUserInput(value as unknown as { prompt: string; images?: ImageAttachment[] });
    } catch {
      return invalid();
    }
  }
  if (
    value.type === 'rename' &&
    (typeof value.title !== 'string' ||
      !value.title.trim() ||
      value.title.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(value.title))
  )
    return invalid();
  if (
    (value.type === 'planApprove' || value.type === 'planReject' || value.type === 'planExecute') &&
    (typeof value.planId !== 'string' || !value.planId.trim() || value.planId.length > 128)
  )
    return invalid();
  if (
    value.type === 'planApprove' &&
    (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash))
  )
    return invalid();
  if (
    value.type === 'planReject' &&
    value.reason !== undefined &&
    (typeof value.reason !== 'string' || value.reason.length > 500)
  )
    return invalid();
  if (
    value.type === 'searchSessions' &&
    (typeof value.query !== 'string' || value.query.length > 200)
  )
    return invalid();
  if (
    (value.type === 'approve' || value.type === 'taskApproval') &&
    typeof value.allow !== 'boolean'
  )
    return invalid();
  if (
    value.type === 'approve' &&
    value.remember !== undefined &&
    typeof value.remember !== 'boolean'
  )
    return invalid();
  if (
    value.type === 'taskApproval' &&
    (typeof value.approvalId !== 'string' ||
      !value.approvalId.trim() ||
      value.approvalId.length > 128)
  )
    return invalid();
  if (value.type === 'questionAnswer') {
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128) return invalid();
    if (value.cancelled !== undefined && typeof value.cancelled !== 'boolean') return invalid();
    // Declining is a complete answer on its own: the run unblocks on an unanswered result.
    if (value.cancelled === true) return value as CarrierCommand;
    if (!Array.isArray(value.answers) || !value.answers.length || value.answers.length > 4)
      return invalid();
    for (const entry of value.answers) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid();
      const answer = entry as Record<string, unknown>;
      if (
        typeof answer.id !== 'string' ||
        !answer.id.trim() ||
        answer.id.length > 32 ||
        !Array.isArray(answer.selected) ||
        answer.selected.length > 6 ||
        answer.selected.some((label) => typeof label !== 'string' || label.length > 120) ||
        (answer.freeText !== undefined &&
          (typeof answer.freeText !== 'string' || answer.freeText.length > 4000)) ||
        Object.keys(answer).some((key) => !['id', 'selected', 'freeText'].includes(key))
      )
        return invalid();
    }
    return value as CarrierCommand;
  }
  if (
    (value.type === 'subagentTranscript' || value.type === 'subagentWorkspace') &&
    (typeof value.subagentId !== 'string' ||
      !value.subagentId.trim() ||
      value.subagentId.length > 128 ||
      typeof value.childSessionId !== 'string' ||
      !value.childSessionId.trim() ||
      value.childSessionId.length > 128)
  )
    return invalid();
  if (
    value.type === 'subagentWorkspace' &&
    !['archive', 'remove', 'restore'].includes(String(value.action))
  )
    return invalid();
  return value as CarrierCommand;
}
