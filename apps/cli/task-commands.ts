import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { SessionStore, TaskCreate } from '../../packages/storage/sqlite.ts';
import type { Approver } from '../../packages/protocol/index.ts';
import {
  verifyTaskAcceptance,
  type TaskBaselines,
} from '../../packages/core/completion/task-acceptance.ts';
import type { Options } from '../shared/args.ts';
import { resolveWorkspace, safeError, display } from '../shared/runtime.ts';

/** Prints a record the way every read-only session command does: pretty unless `--json`. */
function printRecord(value: unknown, options: Options): void {
  process.stdout.write(JSON.stringify(value, null, options.json ? undefined : 2) + '\n');
}

/**
 * The session commands that read or edit stored records — sessions, plans and tasks — without starting a
 * model run. Returns whether `command` was one of them.
 */
export async function runRecordCommand(
  store: SessionStore,
  command: string,
  args: string[],
  options: Options,
  approve: Approver,
): Promise<boolean> {
  if (command === 'plan-show') {
    if (args.length !== 1) throw new Error('Usage: plan-show <session-id>');
    const plan = store.latestPlan(store.get(args[0]!).id);
    if (options.json) process.stdout.write(JSON.stringify({ type: 'plan', plan }) + '\n');
    else if (!plan) process.stdout.write('No plan recorded for this session.\n');
    else {
      process.stdout.write(`${plan.status.toUpperCase()}: ${plan.title}\n`);
      if (plan.summary) process.stdout.write(`${plan.summary}\n`);
      for (const [index, step] of plan.steps.entries())
        process.stdout.write(`  ${index + 1}. ${step.description}\n`);
      if (plan.reason) process.stdout.write(`Reason: ${plan.reason}\n`);
      // The hash is the approval witness: pass it back to plan-execute unchanged.
      process.stdout.write(`plan-id: ${plan.id}\nhash: ${plan.hash}\n`);
    }
    return true;
  }
  if (command === 'sessions') {
    const sessions = store.list();
    process.stdout.write(
      options.json
        ? JSON.stringify(sessions) + '\n'
        : sessions
            .map(
              (s) =>
                // `[active]`, not `[active/interrupted]`: the startup pass converges a run whose owner is
                // gone and records the interruption in the session's own log, so a marker here means a live
                // process is running this session, and the interrupted case is read from the log instead.
                `${s.id}  ${display(s.title || '新会话')}  ${s.workspace}${s.activeRun ? '  [active]' : ''}`,
            )
            .join('\n') + '\n',
    );
    return true;
  }
  if (command === 'show') {
    printRecord({ session: store.get(args[0]!), messages: store.messages(args[0]!) }, options);
    return true;
  }
  if (command === 'tasks') {
    printRecord(store.listTasks(args[0]!), options);
    return true;
  }
  if (command === 'task') {
    printRecord(store.getTask(args[0]!, args[1]!), options);
    return true;
  }
  if (command === 'task-attempts') {
    printRecord(store.listTaskAttempts(args[0]!, args[1]!), options);
    return true;
  }
  if (command === 'task-steps') {
    printRecord(store.taskStepCheckpoints(args[0]!, args[1]!), options);
    return true;
  }
  if (command === 'task-trigger') {
    const spec = args[2]!;
    const cleared = spec === 'off' || spec === 'none';
    let trigger: unknown = null;
    if (!cleared) {
      const file = path.resolve(spec);
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 16_000)
        throw new Error('Trigger spec must be a JSON file <=16KB, or "off" to clear it');
      trigger = JSON.parse(readFileSync(file, 'utf8'));
    }
    printRecord(store.updateTask(args[0]!, args[1]!, { trigger: trigger as never }), options);
    return true;
  }
  if (command === 'task-approval') {
    printRecord(
      store.resolveTaskApproval(args[0]!, args[1]!, args[3] === 'allow', args[2]!),
      options,
    );
    return true;
  }
  if (command === 'task-schedule') {
    // Every workspace the store knows about, so an operator can see what will run unattended.
    const scheduled = store
      .list()
      .flatMap((session) => store.listScheduledTasks(resolveWorkspace(session.workspace)));
    const unique = [...new Map(scheduled.map((task) => [task.id, task])).values()];
    unique.sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''));
    printRecord(unique, options);
    return true;
  }
  if (command === 'task-verify') {
    await verifyTask(store, args, options, approve);
    return true;
  }
  if (command === 'task-create') {
    const specFile = path.resolve(args[1]!);
    const stat = statSync(specFile);
    if (!stat.isFile() || stat.size > 256_000)
      throw new Error('Task spec must be a JSON file <=256KB');
    const spec = JSON.parse(readFileSync(specFile, 'utf8')) as TaskCreate;
    printRecord(store.createTask(args[0]!, spec), options);
    return true;
  }
  return false;
}

async function verifyTask(
  store: SessionStore,
  args: string[],
  options: Options,
  approve: Approver,
): Promise<void> {
  const session = store.get(args[0]!);
  const workspace = resolveWorkspace(session.workspace);
  const task = store.getTask(session.id, args[1]!);
  const baselines = store.latestRunAttemptBaselines(session.id, task.id) as TaskBaselines;
  const attempt = store.startTaskAttempt(session.id, task.id, {
    kind: 'verify',
    baselines,
  });
  try {
    const acceptanceEffects = new Map<string, string>();
    const verified = await verifyTaskAcceptance(
      workspace,
      task,
      baselines,
      undefined,
      async (approval, signal) => {
        const allowed = await approve(approval, signal);
        if (allowed)
          acceptanceEffects.set(
            approval.toolCall.id.slice('acceptance:'.length),
            store.beginTaskEffect(session.id, task.id, attempt.id, approval.toolCall.name),
          );
        return allowed;
      },
    );
    const updated = store.finishTaskAttempt(session.id, task.id, attempt.id, {
      resolvedEffectIds: verified.evidence.checks.flatMap((check) =>
        check.command && !check.command.timedOut
          ? [acceptanceEffects.get(check.id)].filter((id): id is string => Boolean(id))
          : [],
      ),
      /**
       * Completion is withheld until something has actually run — the Host's rule, which the CLI did not have.
       *
       * `verified.passed` alone was enough here, so a task whose checks are machine-checkable could be
       * promoted to `completed` by a verification that never executed a step: `passed` is true for those
       * checks without any run, and the CLI asked for no run gate at all. Same operation, two verdicts, and
       * the CLI's was the one that recorded work nobody had done.
       */
      status: verified.passed && task.latestRunId ? 'completed' : 'needs_review',
      verification: verified.evidence,
      ...(verified.error ? { error: verified.error } : {}),
      acceptance: verified.acceptance,
      steps: verified.steps,
    });
    printRecord(
      { task: updated, attempt: store.getTaskAttempt(session.id, task.id, attempt.id) },
      options,
    );
    process.exitCode = updated.status === 'completed' ? 0 : 1;
  } catch (error) {
    store.finishTaskAttempt(session.id, task.id, attempt.id, {
      status: 'blocked',
      error: safeError(error),
    });
    throw error;
  }
}
