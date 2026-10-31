import type { RunStatus, Task, TaskStep } from '../../protocol/index.ts';
import type { RunTaskSettlement } from '../../storage/session-runs.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { AgentRunInput } from '../agent-options.ts';
import type { RunCompletionState } from './completion.ts';
import type { RunEmit } from './emit.ts';
import type { TaskBaselines } from '../completion/task-acceptance.ts';

type TaskAttempt = ReturnType<SessionStore['startTaskAttempt']>;
type TaskStore = Pick<
  SessionStore,
  | 'getTask'
  | 'listTaskAttempts'
  | 'startTaskAttempt'
  | 'finishRun'
  | 'checkpointTaskStep'
  | 'finishTaskAttempt'
>;

/** Load the task before run admission; reset only this attempt's acceptance evidence. */
export function loadRunTask(
  store: Pick<TaskStore, 'getTask' | 'listTaskAttempts'>,
  input: Pick<AgentRunInput, 'sessionId' | 'taskId'>,
) {
  const task = input.taskId ? store.getTask(input.sessionId, input.taskId) : undefined;
  const previousAttempt = task
    ? store
        .listTaskAttempts(input.sessionId, task.id)
        .filter((attempt) => attempt.kind === 'run')
        .at(-1)
    : undefined;
  if (task) task.acceptance = task.acceptance.map((item) => ({ ...item, met: false }));

  return { task, previousAttempt };
}

/** A failed attempt admission must close the run that was already admitted. */
export function startRunTask(
  store: TaskStore,
  input: AgentRunInput,
  task: Task | undefined,
  runId: string,
  baselines: TaskBaselines,
): TaskAttempt | undefined {
  let taskAttempt: ReturnType<SessionStore['startTaskAttempt']> | undefined;
  try {
    taskAttempt = task
      ? store.startTaskAttempt(input.sessionId, task.id, {
          kind: 'run',
          runId,
          prompt: input.prompt,
          baselines,
          ...(input.taskTrigger ? { trigger: input.taskTrigger } : {}),
          ...(input.resumeTask ? { resume: true } : {}),
        })
      : undefined;
  } catch (cause) {
    store.finishRun({
      runId,
      sessionId: input.sessionId,
      status: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }

  return taskAttempt;
}

/** Register progress only against the active attempt, replacing a reused registry's prior closure. */
export function registerTaskStepTool(
  store: TaskStore,
  tools: ToolRegistry,
  input: Pick<AgentRunInput, 'sessionId'>,
  task: Task | undefined,
  taskAttempt: TaskAttempt | undefined,
  emit: RunEmit,
): void {
  // Starting the attempt re-seeded the step list (a resume keeps completed steps). Re-read just
  // the steps so the prompt describes the work remaining in this attempt, not the previous one.
  if (task && taskAttempt) task.steps = store.getTask(input.sessionId, task.id).steps;
  if (task && taskAttempt) {
    // Registered only while an attempt is live, so the tool cannot write checkpoints against a
    // task that is not actually running. `replace` keeps a reused registry from keeping a stale
    // closure that would checkpoint the previous run's task.
    const attemptId = taskAttempt.id;
    tools.replace({
      name: 'task_step',
      description:
        'Record durable progress on the approved task: mark one step in_progress, completed, blocked or skipped before moving on. Call this as you finish each step so an interrupted run can resume from the last completed step instead of repeating it.',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0, maximum: 63 },
          status: { type: 'string', enum: ['in_progress', 'completed', 'blocked', 'skipped'] },
          note: { type: 'string', maxLength: 500 },
        },
        required: ['index', 'status'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const updated = store.checkpointTaskStep(input.sessionId, task.id, {
            attemptId,
            index: Number(args.index),
            status: String(args.status) as NonNullable<TaskStep['status']>,
            ...(args.note === undefined ? {} : { note: String(args.note) }),
          });
          emit('task.step', { taskId: task.id, steps: updated.steps });
          return {
            isError: false,
            content: updated.steps
              .map((step, index) => `${index}. [${step.status}] ${step.description}`)
              .join('\n'),
          };
        } catch (error) {
          return {
            isError: true,
            content: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }
}

export interface FinishRunTaskOptions {
  store: Pick<TaskStore, 'finishTaskAttempt'>;
  sessionId: string;
  task: Task | undefined;
  taskAttempt: TaskAttempt | undefined;
  status: RunStatus;
  error: string | undefined;
  verification: RunCompletionState['taskVerification'];
}

/** The status a task attempt takes for the run status that produced it. */
function taskAttemptStatus(
  status: RunStatus,
): 'completed' | 'needs_review' | 'cancelled' | 'blocked' {
  if (status === 'completed' || status === 'needs_review') return status;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'limited') return 'needs_review';
  return 'blocked';
}

/**
 * Persist terminal attempt evidence inside `SessionStore.finishRun`'s transaction, so task, attempt
 * and run commit together or not at all. Throws when the attempt cannot be written, rolling the
 * transaction back.
 */
export function finishRunTask(options: FinishRunTaskOptions): RunTaskSettlement | undefined {
  const { store, sessionId, task, taskAttempt, status, error, verification } = options;
  if (!task || !taskAttempt) return undefined;
  const persistedTask = store.finishTaskAttempt(sessionId, task.id, taskAttempt.id, {
    // The verification round already settled acceptance-command effects.
    resolvedEffectIds: [],
    status: taskAttemptStatus(status),
    ...(verification ? { verification: verification.evidence } : {}),
    ...(error ? { error } : {}),
    ...(verification
      ? {
          acceptance: verification.acceptance,
          steps: verification.steps,
        }
      : {}),
  });
  return {
    task: persistedTask,
    // The attempt's own rules can settle lower than the run claimed (an unknown command effect, an unfinished
    // step). Carry that correction so the run row and its completion record are written with it, not after it.
    ...(status === 'completed' && persistedTask.status === 'needs_review'
      ? {
          runDowngrade: {
            status: 'needs_review' as const,
            error: 'Task side effect outcome unknown; inspect state before retrying.',
          },
        }
      : {}),
  };
}
