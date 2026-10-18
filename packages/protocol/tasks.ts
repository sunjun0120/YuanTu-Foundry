/** Durable tasks: status, acceptance, steps, triggers and attempts. */
import type { AcceptanceEvidence, Approval } from './index.ts';

export type TaskStatus =
  'pending' | 'in_progress' | 'completed' | 'needs_review' | 'blocked' | 'cancelled';
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';

export interface AcceptanceCheck {
  id: string;
  kind: 'command' | 'file-exact' | 'file-contains' | 'file-delivery' | 'forbidden-path';
  command?: string;
  args?: string[];
  cwd?: string;
  expectedExitCode?: number;
  timeoutMs?: number;
  path?: string;
  expected?: string;
  maxBytes?: number;
  minBytes?: number;
  sha256?: string;
  format?:
    'auto' | 'binary' | 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'xls' | 'png' | 'jpeg' | 'zip';
  expectation?: 'absent' | 'unchanged';
}

export interface Acceptance {
  description: string;
  met: boolean;
  check?: AcceptanceCheck;
}

export interface TaskStep {
  description: string;
  status: TaskStepStatus;
}

/**
 * One append-only step transition. The journal is the durable record of how far a task actually
 * got, so a run interrupted mid-flight can be resumed from the last completed step instead of
 * redoing work or guessing.
 */
export interface TaskStepCheckpoint {
  id: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  index: number;
  status: TaskStepStatus;
  note?: string;
  createdAt: string;
}

/** Events a durable task can react to. `task.completed` may be narrowed to one source task. */
export type TaskEventName = 'run.finished' | 'task.completed' | 'session.created';
export type TaskMisfirePolicy = 'skip' | 'latest';
export type TaskTrigger =
  | { kind: 'interval'; enabled: boolean; everyMinutes: number; misfire?: TaskMisfirePolicy }
  | {
      kind: 'daily';
      enabled: boolean;
      atMinutes: number;
      timeZone?: string;
      misfire?: TaskMisfirePolicy;
    }
  | {
      kind: 'weekly';
      enabled: boolean;
      atMinutes: number;
      weekdays: number[];
      timeZone: string;
      misfire?: TaskMisfirePolicy;
    }
  | {
      kind: 'cron';
      enabled: boolean;
      expression: string;
      timeZone: string;
      misfire?: TaskMisfirePolicy;
    }
  | { kind: 'at'; enabled: boolean; at: string }
  | { kind: 'after'; enabled: boolean; afterMinutes: number; anchorAt?: string }
  | { kind: 'event'; enabled: boolean; on: TaskEventName; taskId?: string };
/** Why an attempt started. Recovery marks a resume after the Host restarted mid-attempt. */
export type TaskTriggerSource = 'manual' | TaskTrigger['kind'] | 'recovery';

export interface TaskApproval {
  id: string;
  state: 'pending' | 'approved' | 'rejected';
  phase: 'tool' | 'acceptance';
  kind: Approval['kind'];
  tool: string;
  description: string;
  createdAt: string;
  reviewedAt?: string;
}

export type TaskAttemptKind = 'run' | 'verify' | 'review';
export interface TaskAttempt {
  id: string;
  taskId: string;
  sessionId: string;
  ordinal: number;
  kind: TaskAttemptKind;
  runId?: string;
  status: TaskStatus;
  prompt?: string;
  trigger: TaskTriggerSource;
  resume: boolean;
  verification?: AcceptanceEvidence;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  acceptance: Acceptance[];
  verification?: AcceptanceEvidence;
  steps: TaskStep[];
  trigger?: TaskTrigger;
  triggerRevision?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastTriggerError?: string;
  approvalOutcomeUnknown?: boolean;
  pendingApproval?: TaskApproval;
  attemptCount: number;
  latestAttemptId?: string;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set while a scheduled moment this Host was not free to start is still owed.
   *
   * Computed at read time rather than stored, and only by the surfaces that can see the session's log
   * (`task.list` / `task.get`): the record is a `task.due` event, the answer changes the moment the run happens,
   * and a copy of it on the row would be a second truth about the same fact. `since` is the moment the schedule
   * named — the oldest one this task is owed for — and `reason` is why it could not start then.
   */
  waiting?: { since: string; reason: string };
}
