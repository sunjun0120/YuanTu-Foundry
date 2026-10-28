import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { PermissionPolicy } from '../../packages/protocol/permission-policy.ts';
import type { SessionStore } from '../../packages/storage/sqlite.ts';
import type { Approver, Plan, Questioner } from '../../packages/protocol/index.ts';
import { runGoalRounds } from '../../packages/core/goal-driver.ts';
import {
  GOAL_CONTINUATIONS_PER_REQUEST,
  GOAL_TOKENS_PER_REQUEST,
  exhaustedGoalVerdict,
  goalLine,
} from '../../packages/protocol/goals.ts';
import { validateImages, MAX_IMAGE_BYTES } from '../../packages/protocol/images.ts';
import { resolveRunLimits } from '../../packages/protocol/settings.ts';
import { reconcilePendingFileChanges } from '../../packages/tools/file-undo.ts';
import { resolveSandboxConfig } from '../../packages/sandbox/sandbox-provider.ts';
import { normalizeCompletionSpec } from '../../packages/core/completion/contract.ts';
import { SubAgentResidency } from '../../packages/core/subagents/residency.ts';
import { TerminalSessions } from '../../packages/tools/terminal.ts';
import { InvariantRegistry } from '../../packages/core/invariants.ts';
import { logTablesAgreeInvariant } from '../../packages/storage/invariants.ts';
import { emittedEventTypesInvariant } from '../../packages/protocol/invariants.ts';
import { pipelineStagesInvariant } from '../../packages/tools/pipeline.ts';
import type { Options } from '../shared/args.ts';
import { loadHookRegistry } from '../shared/hooks.ts';
import { sessionDatabasePath, createAgent, resolveWorkspace, display } from '../shared/runtime.ts';
import { createEventPrinter, exitCodeFor, reportResult, type RunProgress } from './run-output.ts';
import { ask } from './terminal.ts';

/** The largest completion contract this CLI will read. A definition, not a payload. */
const MAX_COMPLETION_SPEC_BYTES = 128 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * The completion contract the caller asked for, read and normalized before the run starts.
 *
 * Size-bounded before it is parsed: the contract is a definition a person writes, not a payload, and a file
 * that large is either a mistake or an attempt to make the runtime read something else. It is normalized
 * here — before any model request — so an invalid or contradictory contract costs nothing to discover.
 */
function readCompletionSpec(file: string): ReturnType<typeof normalizeCompletionSpec> {
  const absolute = path.resolve(file);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > MAX_COMPLETION_SPEC_BYTES)
    throw new Error(
      `--completion-spec must be a regular JSON file <= ${String(MAX_COMPLETION_SPEC_BYTES)} bytes`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    throw new Error('--completion-spec must contain valid UTF-8 JSON');
  }
  return normalizeCompletionSpec(parsed);
}

function readImages(files: string[]): ReturnType<typeof validateImages> {
  return validateImages(
    files.map((file) => {
      const absolute = path.resolve(file);
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
        throw new Error('Image must be a regular file <=5MB');
      const extension = path.extname(file).toLowerCase();
      return {
        mimeType: IMAGE_TYPES[extension],
        data: readFileSync(absolute).toString('base64'),
        name: path.basename(file),
      };
    }),
  );
}

/** `run`, `resume`, `plan`, `plan-execute` and `task-retry`: the commands that start a model run. */
export async function runAgentCommand(
  store: SessionStore,
  command: string,
  args: string[],
  options: Options,
  permissionPolicy: PermissionPolicy | undefined,
  approve: Approver,
  question: Questioner,
): Promise<void> {
  const existing =
    command === 'resume' || command === 'task-retry' || command === 'plan-execute'
      ? store.get(args[0]!)
      : undefined;
  const workspace = resolveWorkspace(existing?.workspace ?? options.workspace ?? process.cwd());
  if (existing && options.workspace && resolveWorkspace(options.workspace) !== workspace)
    throw new Error('Session belongs to a different workspace');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  // Hooks are loaded once per invocation and shared with the agent's tool registry, so session,
  // prompt, stop and tool hooks all see the same state.
  const hooks = await loadHookRegistry(options.hooks ?? process.env.YUANTU_HOOKS_MODULE, workspace);
  /**
   * The CLI's own runtime invariant registry, built the same way the Host builds one.
   *
   * A one-shot invocation has no long-lived process to report into, so the point here is different: the
   * promises are checked before this invocation's result is printed, and a broken one turns the run into a
   * `failed` run rather than a `completed` one nobody can trust.
   */
  const invariants = new InvariantRegistry({
    timeoutMs: resolveRunLimits(options).invariantTimeoutMs,
  });
  invariants.register(logTablesAgreeInvariant(store));
  invariants.register(emittedEventTypesInvariant());
  invariants.register(pipelineStagesInvariant());
  let sessionId: string | undefined;
  let lifecycleReadOnly = false;
  hooks.observeStop((context) => {
    if (context.sessionId === sessionId && typeof context.readOnly === 'boolean')
      lifecycleReadOnly = context.readOnly;
  });
  const progress: RunProgress = { substantiveToolCalls: 0, previousPlan: [] };
  /**
   * Resident sub-agents live as long as this invocation does.
   *
   * The CLI is one-shot, so residency buys exactly one thing here: a run can ask a child it delegated to
   * for a follow-up without delegating the same ground again. Disposal is child-first and happens before
   * the store closes, so a child's tools are released while its session can still be written to.
   */
  const residency = new SubAgentResidency();
  /**
   * The invocation's terminals.
   *
   * The CLI is one-shot, so "the process owns them" and "this invocation owns them" are the same statement; the
   * scope they are opened under is this process's, because the CLI never passes a per-session scope to
   * `createAgent`. A terminal only helps here while the process lives, which is exactly one command.
   */
  const terminals = new TerminalSessions(workspace);
  try {
    const agent = await createAgent(
      store,
      workspace,
      options,
      approve,
      // Read at request time: `--permission-policy` is fixed for this invocation, but keeping it a getter
      // means a host that can change the policy mid-session needs no separate wiring.
      () => permissionPolicy,
      createEventPrinter(options, progress),
      undefined,
      undefined,
      hooks,
      residency,
      question,
      invariants,
      terminals,
      undefined,
      controller.signal,
    );
    const session = existing ?? store.create(workspace);
    sessionId = session.id;
    lifecycleReadOnly =
      command === 'plan' || (command === 'resume' && store.planMode(session.id) !== null);
    if (existing) progress.previousPlan = store.todos(session.id);
    const retryTaskId = command === 'task-retry' ? args[1]! : undefined;
    /**
     * The gate a manual retry has to pass, which the Host applies and the CLI did not.
     *
     * `run-start.ts` refuses a manual retry while the task's approval is pending and not rejected: that work is
     * waiting on a person, and retrying it starts a second attempt over the top of a decision nobody has made.
     * The CLI builds its own agent and has its own run path, so it never reached that handler — and the task id
     * it does pass (below) cannot help, because the gate lives in the handler the CLI does not use. It started
     * exactly the run the Host defers, and the deferred approval was then left for whatever verification came
     * next to consume.
     *
     * An unattended start is exempt in the Host because the clock is not a person deciding; `task-retry` is a
     * person asking, so the exemption has nothing to cover here.
     */
    if (retryTaskId) {
      const pending = store.getTask(session.id, retryTaskId).pendingApproval;
      if (pending && pending.state !== 'rejected')
        throw new Error('Review the pending task approval before a manual retry');
    }
    /**
     * `plan-execute` re-checks the approval the same way the Host does — one implementation of the
     * gate, in the store — before anything runs. `plan` is the read-only planning phase, and it
     * ends by asking a human; without a TTY it stops and prints the hash to approve with.
     */
    const planCommand = command === 'plan' || command === 'plan-execute';
    let executingPlan: Plan | undefined;
    if (command === 'plan-execute') {
      const current = store.getPlan(session.id, args[1]!);
      // The hash proves the human approved the text that is on the row now, so it is compared
      // before the approval is recorded rather than after.
      if (current.hash !== args[2]!)
        throw new Error('The supplied hash does not match this plan; re-read it with plan-show');
      if (current.status === 'proposed') store.approvePlan(session.id, current.id, args[2]!);
      // Then the same gate the Host uses, so approval and execution cannot disagree.
      executingPlan = store.executablePlan(session.id, current.id);
    }
    const latestRun = retryTaskId
      ? store
          .listTaskAttempts(session.id, retryTaskId)
          .filter((attempt) => attempt.kind === 'run')
          .at(-1)
      : undefined;
    const prompt =
      command === 'task-retry'
        ? args[2]?.trim() || latestRun?.prompt
        : planCommand
          ? command === 'plan-execute'
            ? `${executingPlan!.title}\n\n${executingPlan!.summary}`.trim()
            : args[0]!
          : args[existing ? 1 : 0]!;
    if (!prompt) throw new Error('Task has no prior run prompt; provide prompt');
    const completionSpec =
      options.completionSpec === undefined ? undefined : readCompletionSpec(options.completionSpec);
    await reconcilePendingFileChanges(store, session.id, workspace);
    if (!options.json) process.stderr.write(`Session: ${session.id}\nWorkspace: ${workspace}\n`);
    /**
     * A session that was planning when it stopped is still planning.
     *
     * Plan mode is a promise that this run cannot change anything, and it lived only in the request that started
     * it: `plan` created the row and passed `planPhase`, and `resume` passed neither, so a session whose
     * planning run ended without submitting — the user's Stop, a crash, a lost terminal — came back as an
     * ordinary run with the full tool set. The write it then made would have been refused a moment earlier.
     *
     * The rule itself lives in `store.planMode`, because the Host asks the same question and the two answers
     * have to agree.
     */
    const resumed = command === 'resume' ? store.planMode(session.id) : null;
    const plan =
      command === 'plan'
        ? store.createPlan(session.id)
        : resumed?.planId
          ? { id: resumed.planId }
          : undefined;
    lifecycleReadOnly = plan !== undefined;
    for (const failure of await hooks.sessionStart(
      {
        sessionId: session.id,
        workspace,
        resumed: Boolean(existing),
        readOnly: lifecycleReadOnly || resolveSandboxConfig().files === 'read-only',
      },
      controller.signal,
    ))
      process.stderr.write(`sessionStart hook failed: ${failure}\n`);
    let result = await agent.run({
      sessionId: session.id,
      prompt,
      ...(plan ? { planPhase: true, planId: plan.id } : {}),
      ...(executingPlan ? { approvedPlan: executingPlan } : {}),
      ...(completionSpec === undefined ? {} : { completion: completionSpec }),
      images: readImages(options.images ?? []),
      signal: controller.signal,
      ...(retryTaskId ? { taskId: retryTaskId } : options.taskId ? { taskId: options.taskId } : {}),
    });
    reportResult(options, result);
    process.exitCode = exitCodeFor(result);
    /**
     * Rounds a goal starts on its own.
     *
     * A goal is the session's own statement of what it is trying to achieve, and until now nothing ever
     * started the run that would continue it — the next command did. With a goal active, this invocation
     * keeps going: each round is an ordinary run (its own step, tool and time limits), the goal's own round
     * budget bounds how many, and the loop stops on a terminal goal, a spent budget, a round that did not
     * finish, or the user's interrupt. Only `run` and `resume` continue, and only when this invocation is not
     * a planning run: a task retry is a deliberate single attempt, a plan ends by handing a decision to a
     * human, and a planning run may not touch the goal at all — the goal tools are not registered in that
     * phase (`ownWork` excludes it), so a round started for one would be spent on work the run cannot do.
     * `resume` *is* a planning run when the session stopped mid-plan, and there the continuation would be
     * worse than idle: it is an ordinary run, which is the escape resuming mid-plan exists to close. The Host
     * draws the same line for the same three kinds of run (`!plan && !plannedTaskId && !approvedPlan`), so
     * this is the two carriers agreeing rather than a rule invented here.
     */
    if ((command === 'run' || command === 'resume') && !plan) {
      const rounds = await runGoalRounds({
        // The same second bound the Host uses, and not the goal's own ceiling: `max_goal_rounds` is a record
        // the model may raise, and a loop bounded only by it is a loop the thing it bounds can extend.
        maxContinuations: GOAL_CONTINUATIONS_PER_REQUEST,
        maxTokens: GOAL_TOKENS_PER_REQUEST,
        signal: controller.signal,
        goalOf: () => store.goal(session.id),
        /**
         * The continuation is narrated on stderr in every mode, json included: it is an event like
         * `[model]` and `[retry]`, and a machine-readable run that silently sat through four rounds
         * would be the hardest one to explain afterwards.
         */
        onRound: (continuation) => {
          process.stderr.write(`[goal] round ${continuation.round}\n`);
        },
        // A spent budget leaves the goal `active`, which reads as "more rounds are coming" when none are.
        // The verdict is written through the same durable event every other goal change uses.
        onExhausted: (goal) => {
          const verdict = exhaustedGoalVerdict(goal, new Date().toISOString());
          if (!verdict) return;
          store.recordEvent(session.id, 'goal.changed', { action: 'blocked', goal: verdict });
          process.stderr.write(`[goal] ${goalLine(verdict)}\n`);
        },
        runOnce: async (prompt) => {
          /**
           * A continuation carries the session's contract rather than starting a second one.
           *
           * `resumeCompletionId` restores the definition, the budget and the repair clock the previous round
           * was already spending; without it, round two of a verified request would look like a fresh run with
           * no evidence, and the repair budget would reset every round — the one thing a bounded loop must not
           * let happen.
           */
          const contract = store.completionCurrent(session.id);
          progress.substantiveToolCalls = 0;
          result = await agent.run({
            sessionId: session.id,
            prompt,
            signal: controller.signal,
            // Started by the runtime to carry the goal forward, not by the user: it may report on the goal but
            // not change who is in charge of it (see `HUMAN_ONLY_GOAL_ACTIONS`).
            authority: 'automatic',
            ...(contract ? { resumeCompletionId: contract.contractId } : {}),
          });
          reportResult(options, result);
          // Substantive tool activity is what makes a round progress; a round that only talked stops the loop.
          return {
            status: result.status,
            toolCalls: progress.substantiveToolCalls,
            tokens: result.usage.inputTokens + result.usage.outputTokens,
          };
        },
      });
      if (rounds.continuations > 0) {
        process.stderr.write(
          `[goal] stopped after ${rounds.continuations} round(s): ${rounds.stopped}\n`,
        );
        process.exitCode = exitCodeFor(result);
      }
    }
    /**
     * A planning run ends by handing the decision to a human. With a TTY we can ask; without one we
     * stop and print the exact approval command, because a non-interactive run must never approve
     * its own plan.
     */
    if (plan) {
      const proposed = store.latestPlan(session.id)!;
      if (!options.json) {
        process.stdout.write(`\n${proposed.title}\n`);
        if (proposed.summary) process.stdout.write(`${proposed.summary}\n`);
        for (const [index, step] of proposed.steps.entries())
          process.stdout.write(`  ${index + 1}. ${step.description}\n`);
      }
      // These commands must reopen the store that actually contains the reviewed plan, including
      // --db/--workspace invocations. Quote for the operator's PowerShell or POSIX shell.
      const quote = (value: string) =>
        "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
      const route = `--db ${quote(sessionDatabasePath(options))} --workspace ${quote(workspace)}`;
      const reviewCommand = `npm run dev -- plan-show ${session.id} ${route}`;
      const approveCommand = `npm run dev -- plan-execute ${session.id} ${proposed.id} ${proposed.hash} ${route}`;
      if (options.json) {
        process.stdout.write(
          JSON.stringify({ type: 'plan', plan: proposed, reviewCommand, approveCommand }) + '\n',
        );
      } else if (process.stdin.isTTY && process.stdout.isTTY) {
        const answer = await ask(`\nApprove and execute this plan? [y/N] `);
        if (answer.trim().toLowerCase() === 'y') {
          store.approvePlan(session.id, proposed.id, proposed.hash);
          const executed = await agent.run({
            sessionId: session.id,
            prompt: `${proposed.title}\n\n${proposed.summary}`.trim(),
            approvedPlan: store.executablePlan(session.id, proposed.id),
            signal: controller.signal,
          });
          process.stdout.write(`\n[${executed.status}] ${display(executed.text)}\n`);
          process.exitCode = executed.status === 'completed' ? 0 : 1;
        } else {
          process.stderr.write(`\nPlan left unapproved.\n`);
        }
      } else {
        process.stderr.write(
          `\nReview, then run (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'}):\n  ${reviewCommand}\n  ${approveCommand}\n`,
        );
      }
    }
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    // The CLI is one-shot, so the host-shutdown path is simply the end of this invocation. Resident
    // children are released before the store closes, deepest first, and any terminal this run opened is
    // closed with them: the pty holds a real process, and nothing would outlive this invocation to close it.
    try {
      await terminals.closeAllAndWait();
    } finally {
      await residency.disposeAll().catch(() => undefined);
      if (sessionId) {
        const failures = await hooks
          .sessionEnd(
            {
              sessionId,
              reason: 'shutdown',
              readOnly: lifecycleReadOnly || resolveSandboxConfig().files === 'read-only',
            },
            new AbortController().signal,
          )
          .catch(() => []);
        for (const failure of failures)
          process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
      }
      await hooks.close().catch(() => undefined);
    }
  }
}
