import { randomUUID } from 'node:crypto';
import type { SubAgentSummary, Tool, Usage } from '../../protocol/index.ts';
import { failure } from '../../tools/registry.ts';
import { billableTokens } from '../../protocol/statistics.ts';
import type { SubAgentOutcome, SubAgentRequestOptions } from './providers.ts';
import {
  EXPLORE_TOOLS,
  REPORT_SCHEMA,
  SubAgentLimitError,
  boundedError,
  normalizeTasks,
  renderFindings,
  report,
  tasksSchema,
} from './contract.ts';
import {
  EMPTY_USAGE,
  NEVER,
  SUBAGENT_CEILINGS,
  Semaphore,
  abortSignal,
  budgetMessage,
  delay,
  inboxNotice,
  isSelected,
  stallMessage,
  startedNotice,
  whenTrue,
  type AdmittedTask,
  type BatchWorkspace,
  type ScheduledSubAgent,
  type SubAgentAnswer,
  type SubAgentCoordinatorDeps,
  type SubAgentResult,
} from './support.ts';
export {
  SUBAGENT_CEILINGS,
  SUBAGENT_DEFAULTS,
  budgetMessage,
  resolveSubAgentOptions,
} from './support.ts';
export type {
  AdmittedTask,
  BatchWorkspace,
  ResolvedSubAgentOptions,
  SubAgentAnswer,
  SubAgentCoordinatorDeps,
  SubAgentOptions,
  SubAgentResult,
} from './support.ts';
// The contract's public names stay importable from here, so callers did not move with the code.
export * from './contract.ts';
export type {
  SubAgentCapability,
  SubAgentOutcome,
  SubAgentParent,
  SubAgentProvider,
  SubAgentRequestOptions,
  SubAgentSeed,
  SubAgentStartRequest,
  SubAgentTask,
} from './providers.ts';
export {
  SubAgentCapabilityError,
  SubAgentProviderRegistry,
  UnknownSubAgentProviderError,
} from './providers.ts';

/**
 * Why a child was stopped by its own controller: the call that started it, or the run ending around it.
 *
 * One function because a child reaped before it started and one stopped mid-turn are told about the same cause,
 * and two copies of the sentence is how one of them came to name the run for a call's deadline.
 */
function cancellationReason(scheduled: ScheduledSubAgent, runAborted: boolean): string {
  // A cancelled run cancels the tool call inside it too; the run is the cause then, not the call.
  return scheduled.callerStopped && !runAborted
    ? 'Cancelled: the call that started this sub-agent was stopped or ran out of time'
    : 'Cancelled: the run that started this sub-agent ended without collecting it';
}

/**
 * Sub-agent delegation.
 *
 * The parent loop stays serial; what this module adds is a bounded fan-out to child runs that each own
 * a private session, so a long or noisy side investigation costs the parent one bounded report instead
 * of a transcript. Everything here is deliberately capped: an agent that can spawn agents without
 * limits can spend an unbounded amount of the user's money on its own judgement.
 */
export class SubAgentCoordinator {
  private deps: SubAgentCoordinatorDeps;
  private readonly records: SubAgentSummary[] = [];
  /** One semaphore per run, not per call: background and blocking tasks must share the same cap. */
  private readonly limiter: Semaphore;
  private readonly scheduled: ScheduledSubAgent[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private started = 0;
  constructor(deps: SubAgentCoordinatorDeps) {
    this.deps = deps;
    this.limiter = new Semaphore(deps.options.maxConcurrency);
  }
  /**
   * The parent's read-only promise was lifted, so its children's is too.
   *
   * Called when a planning run has its plan approved mid-run: the parent may now write, and a run that may
   * write may also delegate work that writes. Without this the guard below would keep refusing a `general`
   * child for a restriction that no longer exists — a refusal that is merely mysterious, since the parent can
   * see its own write tools back.
   *
   * One direction only, and deliberately: there is no path that makes a run read-only again, because an
   * approval is not a thing a run can undo.
   */
  promoteToWritable(): void {
    if (!this.deps.readOnly) return;
    this.deps = { ...this.deps, readOnly: false };
  }
  get summaries(): SubAgentSummary[] {
    return this.records.map((record) => ({ ...record }));
  }
  /**
   * The tool the parent model calls. Delegation itself needs no approval: a sub-agent cannot exceed
   * the parent's authority, because every write, command or external call it makes goes through the
   * same approver as the parent's own tools.
   */
  tool(): Tool {
    return {
      name: 'delegate_task',
      description:
        'Delegate self-contained work to sub-agents that run in parallel, each with its own context, and return a report. ' +
        'Use it for broad independent investigation (several parts of the codebase at once) or for a long side quest whose raw output you do not want in this conversation. ' +
        'Do not use it for work you could finish with one or two tool calls, and do not use it to hand off the whole user request. ' +
        'A sub-agent starts with no memory of this conversation: put everything it needs in `objective` and `context`, and ask for a specific report (findings, exact file paths, evidence, open questions). ' +
        "`role: 'explore'` (default) is read-only; `role: 'general'` may change the workspace and run commands and will still ask the user for each permission, so prefer `explore` unless the work must write. " +
        'Sub-agents cannot delegate further and cannot ask you questions; verify their claims before reporting them as your own. ' +
        'Each task may name a `model`; call `list_subagent_models` to see which ones this host can actually serve, because an id it cannot serve is refused rather than run on the default. ' +
        'By default this waits for the reports. Set `wait: false` to start them and carry on with your own work while they run — then call `collect_subagents` before you finish. A sub-agent still working when your run ends is stopped, but it is not lost: it stays reachable, and its outcome is reported to you at the start of your next turn in this session, so you can collect it then or ask that same child to continue with `send_message` rather than doing the work again.',
      inputSchema: {
        type: 'object',
        properties: {
          wait: {
            type: 'boolean',
            description:
              'true (default) returns the reports in this result. false starts them and returns immediately, so you can keep working and collect later.',
          },
          tasks: tasksSchema(this.deps.options.maxFanout, this.deps.providers.names()),
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      execute: (args, context) => this.delegate(args, context.signal, false),
    };
  }
  /**
   * The same delegation, for a child that continues *this* conversation instead of starting from nothing.
   *
   * It is a separate tool rather than a flag on `delegate_task`, for the reason the capability is separate
   * too: a fork inherits the parent's history, which is a different promise from "a fresh child with a good
   * brief", and a model that has to choose between two names has to notice which one it is making.
   */
  forkTool(): Tool {
    return {
      name: 'subagent_fork',
      description:
        'Delegate work to a sub-agent that starts from **this conversation** instead of from nothing: it inherits the transcript above (trimmed from the oldest end to stay within a fixed budget), so you do not have to restate what you have already established. ' +
        'Use it when the work depends on everything discussed so far — continue a hypothesis you are already part-way through, or push a long investigation out of this context while keeping its premises. ' +
        "For anything self-contained, prefer `delegate_task`: a fork pays for the inherited history on every one of the child's rounds. " +
        'The child inherits the *history*, not your identity: it keeps its own sub-agent role prompt, its own session and the same permission rules, and it cannot ask you questions or delegate further. ' +
        "Everything a `delegate_task` task takes is accepted here, including `role` and `model`, and `role: 'general'` still needs an approving user for every write.",
      inputSchema: {
        type: 'object',
        properties: {
          wait: {
            type: 'boolean',
            description:
              'true (default) returns the reports in this result. false starts them and returns immediately, so you can keep working and collect later.',
          },
          tasks: tasksSchema(this.deps.options.maxFanout, this.deps.providers.names()),
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      execute: (args, context) => this.delegate(args, context.signal, true),
    };
  }
  /**
   * What a task may be run on, as this host can actually serve it.
   *
   * Registered only when the host supplied the list. An empty list is not an option: the caller then has
   * nothing to choose between, and saying so is the tool's job rather than its caller's.
   */
  modelsTool(): Tool {
    return {
      name: 'list_subagent_models',
      description:
        'List the models this host can actually run a sub-agent on. Call it before naming a `model` in `delegate_task` or `subagent_fork`: a model that is not on this list is refused, and the task is not started.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, context) => {
        context.signal.throwIfAborted();
        try {
          const models = this.deps.models?.() ?? [];
          if (!models.length)
            return {
              isError: false,
              content:
                'No sub-agent model list is available from this host, so name no `model` and the child will run on the default.',
            };
          const lines = models.map(
            (entry) => `- ${entry.model}${entry.note ? ` — ${entry.note}` : ''}`,
          );
          lines.push(
            models.length === 1
              ? 'That is the only model this host is configured to serve for sub-agents; a task that names any other id is refused rather than run on this one.'
              : 'Any other model id is refused rather than run on one of these.',
          );
          return { isError: false, content: lines.join('\n') };
        } catch (error) {
          return failure(error);
        }
      },
    };
  }
  /** The body both delegation tools share; `fork` is the only difference between them. */
  private async delegate(
    args: Record<string, unknown>,
    signal: AbortSignal,
    fork: boolean,
  ): Promise<{ isError: boolean; content: string }> {
    signal.throwIfAborted();
    try {
      const tasks = this.admit(args.tasks, this.deps.options.maxFanout, fork);
      /**
       * The batch's directories are decided once, here, before a single child is scheduled.
       *
       * This is the ordering the plan is explicit about, and it has two halves. The baseline is frozen *after*
       * provider and capability validation, so a task that will be refused leaves no snapshot behind; and it is
       * frozen *before* the tasks are scheduled, so the ones still queued behind the concurrency cap see exactly
       * the bytes the first one saw. A child that started later would otherwise read a directory the early
       * children had already changed.
       */
      const batch = await this.deps.workspaceForBatch?.({ tasks, signal });
      const scheduled = tasks.map((task, index) => this.schedule(task, index, tasks.length, batch));
      /**
       * The call's own cancellation reaches the children it admitted, and stops reaching them when the call is
       * over.
       *
       * Those are two halves of one promise. A call that was cut off — an explicit deadline on this tool, a
       * cancelled request — must not leave behind work nobody will ever collect: the children's turns would keep
       * running (and keep spending) after the only caller that was waiting for their answer had gone, and the
       * model would have been told the call failed while the workspace kept changing. The second half is why
       * this listener is removed in the `finally`: a `wait: false` call *returns* on purpose, and tying it to
       * the children it handed off would make handing work off impossible — while the run's own end still stops
       * them, because that is the signal the children were built with.
       */
      const stop = () => {
        for (const task of scheduled) {
          // Named as the call's stop, not the run's: the reason a child reports is read from this flag.
          task.callerStopped = true;
          task.controller.abort(signal.reason);
        }
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
      try {
        if (args.wait === false) {
          // Deliberately not awaited: returning here is the point of `wait: false`. The promises are
          // tracked, so `settle()` still joins them when the run ends.
          for (const task of scheduled) void this.run(task);
          return { isError: false, content: startedNotice(scheduled) };
        }
        /**
         * A blocking call stops waiting when the user corrects the course.
         *
         * Without this the parent is parked inside one tool call for as long as the fan-out takes (up to
         * the per-child timeout), so a correction could not be read until every child had finished —
         * which is the whole reason `wait: false` exists. The children are *not* cancelled: the call
         * degrades to "started, collect later", so a correction costs a round, not the work.
         */
        const settled = Promise.all(scheduled.map((task) => this.run(task)));
        const steer = this.deps.steerPending ? whenTrue(this.deps.steerPending) : undefined;
        try {
          await (steer ? Promise.race([settled, steer.promise]) : settled);
        } finally {
          steer?.dispose();
        }
        if (this.deps.steerPending?.()) {
          void settled;
          return { isError: false, content: startedNotice(scheduled, true) };
        }
        // A blocking call hands its reports over in the result, so they are collected by definition — and that
        // has to be written down for the same reason the tool path does: the parent must not be reminded about
        // a report it already read in this very tool result.
        for (const task of scheduled) task.collected = true;
        this.deps.collected?.(scheduled.map((task) => task.id));
        return report(
          scheduled.map((task) => ({
            summary: task.summary,
            text: task.text,
            ...(task.seed ? { seed: task.seed } : {}),
            ...(task.data !== undefined ? { data: task.data } : {}),
          })),
          tasks,
        );
      } finally {
        signal.removeEventListener('abort', stop);
      }
    } catch (error) {
      return failure(error);
    }
  }
  /**
   * The read-only and per-run guards, in one place because both entry points need them and a second
   * copy is how one of them would end up weaker than the other.
   */
  private admit(value: unknown, maxFanout: number, fork: boolean): AdmittedTask[] {
    const tasks = normalizeTasks(value, maxFanout, this.deps.workspaceMode ?? 'shared').map(
      (task) => ({
        ...task,
        fork,
      }),
    );
    if (this.deps.readOnly && tasks.some((task) => task.role === 'general'))
      throw new SubAgentLimitError('This run is read-only, so it may only delegate explore tasks');
    const remaining = this.deps.options.maxPerRun - this.started;
    if (tasks.length > remaining)
      throw new SubAgentLimitError(
        remaining > 0
          ? `This run may start ${remaining} more sub-agent task(s); reduce the number of tasks`
          : `This run already used its ${this.deps.options.maxPerRun} sub-agent tasks`,
      );
    // Capability validation happens here, before anything is scheduled: a provider that cannot honour a
    // requested option must refuse the call, not accept it and quietly ignore that part. Nothing has
    // been created yet, so a refusal leaves no child session behind either.
    for (const task of tasks)
      this.deps.providers.resolve(this.providerFor(task), this.requestOptions(task));
    return tasks;
  }
  /**
   * Which provider runs this task: the one it named, or the run's own.
   *
   * One function because both resolution sites need the same answer, and a task that was validated against the
   * default while being scheduled onto a named provider would be exactly the "checked one thing, ran another"
   * gap the capability registry exists to close.
   */
  private providerFor(task: AdmittedTask): string {
    return task.provider ?? this.deps.provider;
  }
  /**
   * What one task asks the provider for. Only what the task genuinely needs is requested: a capability
   * assertion is a promise about the run, so asking for one nobody uses would refuse providers for no
   * reason.
   */
  private requestOptions(task: AdmittedTask): SubAgentRequestOptions {
    const provider = this.deps.providers.resolve(this.providerFor(task), {});
    return {
      ...(task.model ? { agentOptions: { model: task.model } } : {}),
      /**
       * The structured answer, asked for when it has to be **enforced**.
       *
       * Two cases, and the difference is the whole reason this is conditional. A task that declared its own
       * `schema` is asking the provider to hold the child to it — a promise, so it is requested, and a provider
       * that cannot keep it must refuse. A task with no schema gets the fixed report contract instead, which the
       * *coordinator* can compose from whatever the child said: that is not something a provider has to be able to
       * do, and requiring it would refuse every provider that runs its child somewhere else (a separate process
       * has no `submit_report` tool to enforce a shape with). Requesting a capability nobody needs is the failure
       * the comment above warns about, and it was refusing exactly the provider this seam exists to allow.
       */
      ...(task.schema !== undefined
        ? { outputSchema: task.schema }
        : provider.capabilities.includes('outputSchema')
          ? { outputSchema: REPORT_SCHEMA }
          : {}),
      maxDepth: this.deps.options.maxDepth,
      ...(task.role === 'explore' ? { toolFilter: [...EXPLORE_TOOLS] } : {}),
      /**
       * Isolation is asked for only when it is genuinely needed.
       *
       * A `shared` task requests nothing: sharing is what every provider already does, so asking for it would make
       * a provider that runs its child out-of-process unusable for the work it can perfectly well do. `worktree` is
       * a promise about where the writes land, and a provider that cannot keep it must refuse the task instead of
       * accepting it and running in the delegator's directory.
       */
      ...(task.workspaceMode === 'worktree' ? { workspace: 'worktree' as const } : {}),
      /**
       * The role prompt is **not** sent here, and that is a correction rather than an omission.
       *
       * `persona` used to be set to `subAgentRolePrompt(task.role)`, which asked every provider to take the child's
       * role and put it in the persona slot. A `persona` shadows the deployment's, so a provider that honoured it
       * literally would have replaced the harness's own identity paragraph — the one that carries how to use
       * tools, when to verify a deliverable and what is excluded from them — with "you are a sub-agent". The role
       * belongs where it already goes: `AgentOptions.rolePrompt`, which is additive and applied by the child
       * composition. This option now means what its name says, and is only present when a caller actually has a
       * persona to install.
       */
      ...(task.persona ? { persona: task.persona } : {}),
      // Only asked for when it is wanted, so a provider that cannot fork is still usable for everything else.
      ...(task.fork ? { contextFork: true } : {}),
    };
  }
  /**
   * Takes on one task: identity, provider and record, before anyone waits for it. `wait: false` depends on
   * this being separate from running.
   *
   * Admission is a count and nothing else: the per-run total is checked in `admit`, and the semaphore is what
   * bounds how many of the admitted ones may run at once. A task is therefore never scheduled into a state
   * where it can be admitted but cannot be paid for — which is what the old shared token pool could produce,
   * and what made a late delegation report "N tokens remained" instead of an honest limit.
   */
  private schedule(
    task: AdmittedTask,
    index: number,
    total: number,
    batch?: BatchWorkspace,
  ): ScheduledSubAgent {
    const id = randomUUID();
    const options = this.requestOptions(task);
    // Resolve (and re-assert) the provider here rather than at dispatch time: the scheduled task must
    // know which provider accepted it, and `wait: false` hands the task to `run` with nobody watching.
    const provider = this.deps.providers.resolve(this.providerFor(task), options);
    const summary: SubAgentSummary = {
      id,
      role: task.role,
      objective: task.objective,
      sessionId: '',
      status: 'running',
      rounds: 0,
      toolCalls: 0,
      usage: { ...EMPTY_USAGE },
    };
    this.records.push(summary);
    let settleTask!: () => void;
    const promise = new Promise<void>((resolve) => {
      settleTask = resolve;
    });
    const scheduled: ScheduledSubAgent = {
      id,
      index,
      total,
      role: task.role,
      objective: task.objective,
      ...(task.context ? { context: task.context } : {}),
      ...(task.schema ? { schema: task.schema } : {}),
      fork: task.fork,
      options,
      provider,
      summary,
      text: '',
      collected: false,
      done: false,
      active: false,
      controller: new AbortController(),
      stallController: new AbortController(),
      budgetController: new AbortController(),
      promise,
      settleTask,
      admitted: task,
      ...(batch ? { batch } : {}),
    };
    this.started++;
    this.scheduled.push(scheduled);
    return scheduled;
  }
  /**
   * Runs one child to completion and hands back its answer, for a caller that is not a tool call.
   *
   * `delegate_task` admits and schedules, `collect_subagents` reads back; a workflow script wants both halves
   * fused for a single task, one call at a time. Routing it through the same admission, the same semaphore and
   * the same execution is what keeps the caps real: a loop inside a script goes through the same per-run total as
   * a loop of tool calls, so the workflow tool cannot become the way around them.
   *
   * The child is marked delivered as soon as its answer is handed over — the caller is looking at it, and a
   * settlement notice would be announcing something that has already been read.
   */
  async runOne(
    task: { objective: string; context?: string; model?: string; schema?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<SubAgentAnswer> {
    const [admitted] = this.admit([task], 1, false);
    const scheduled = this.schedule(admitted!, 0, 1);
    /**
     * The caller's cancellation propagates into the child.
     *
     * `execute` already ties the child to the parent run and to this task's own controller; what it cannot know
     * is the *call* that asked, which for a workflow is one tool invocation with its own deadline. Without this,
     * a workflow whose time ran out would leave its children running.
     */
    const stop = () => {
      scheduled.callerStopped = true;
      scheduled.controller.abort(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    try {
      await this.run(scheduled);
    } finally {
      signal.removeEventListener('abort', stop);
    }
    scheduled.collected = true;
    this.deps.collected?.([scheduled.id]);
    return {
      status: scheduled.summary.status,
      sessionId: scheduled.summary.sessionId,
      rounds: scheduled.summary.rounds,
      // The child's own answer when it has no prose of its own: a structured child is told to end by calling
      // `submit_report`, so its *text* is often empty and what it submitted is the whole answer.
      answer:
        scheduled.text.trim() ||
        (scheduled.data !== undefined
          ? JSON.stringify(scheduled.data)
          : renderFindings(scheduled.summary.report).join('\n')),
      ...(scheduled.data !== undefined ? { data: scheduled.data } : {}),
      ...(scheduled.summary.error ? { error: scheduled.summary.error } : {}),
    };
  }
  /** Runs a scheduled task under the shared cap, and resolves when it has settled. */
  private run(scheduled: ScheduledSubAgent): Promise<void> {
    if (scheduled.done) return Promise.resolve();
    const promise = this.limiter
      .run(() => this.execute(scheduled))
      // Provider failures are outcomes; failures after the provider returned belong to settlement.
      // Keep them on the task so both synchronous callers and background collectors can observe them.
      .catch((error: unknown) => {
        scheduled.summary.status =
          scheduled.summary.status === 'cancelled' ? 'cancelled' : 'failed';
        scheduled.summary.error = boundedError(
          [
            scheduled.summary.error,
            `Sub-agent settlement failed: ${error instanceof Error ? error.message : String(error)}`,
          ]
            .filter(Boolean)
            .join('; '),
        );
      })
      // Every path out of `execute` goes through here, including the reaping that returns before the body runs
      // and the provider rejecting synchronously: a timer that survived its child would abort a controller
      // nobody is listening to and hold the process open for the rest of the window.
      //
      // `active` goes back to false with the timer, and that half is not bookkeeping. It is what `progress`
      // reads to decide whether there is a live run to re-arm, and leaving it true meant a *resident* child's
      // later turn — which the coordinator does not run, and therefore never arms a watchdog for — kept arming
      // timers for a task that had already settled, with nothing left that would ever clear them. The process
      // stayed alive for the whole stall window, which is exactly the leak this `finally` exists to prevent.
      .finally(() => {
        this.disarmStallWatchdog(scheduled);
        scheduled.active = false;
        scheduled.done = true;
        scheduled.settleTask();
      });
    this.inFlight.add(promise);
    return promise.finally(() => this.inFlight.delete(promise));
  }
  /**
   * Starts (or restarts) this child's stall watchdog.
   *
   * The timer is deliberately *not* unref'd. It is the only thing standing between a wedged child and a parent
   * run that can never end, and a process that exits while a run is open has already lost that run's outcome —
   * so keeping the loop alive for the remaining window is the honest behaviour. Zero disables it, which is a
   * choice the operator makes knowing the bound is gone (see `SubAgentOptions.timeoutMs`).
   */
  private armStallWatchdog(scheduled: ScheduledSubAgent): void {
    this.disarmStallWatchdog(scheduled);
    scheduled.active = true;
    if (this.deps.options.timeoutMs <= 0) return;
    scheduled.stallTimer = setTimeout(() => {
      // Only the stall controller. Aborting `scheduled.controller` here would be wrong twice over: that signal is
      // the run-end reaping, and a stalled child reported as "the run ended without collecting it" would name the
      // wrong cause. Composing into `signal` is what actually stops the child.
      scheduled.stallController.abort(new Error(stallMessage(this.deps.options.timeoutMs)));
    }, this.deps.options.timeoutMs);
  }
  private disarmStallWatchdog(scheduled: ScheduledSubAgent): void {
    if (scheduled.stallTimer === undefined) return;
    clearTimeout(scheduled.stallTimer);
    scheduled.stallTimer = undefined;
  }
  /**
   * The child showed progress, so its watchdog starts over.
   *
   * Called from the parent's own emit, which is the only seam both of a child's frame paths pass through: the
   * durable announcements (`subagent.started`, `subagent.finished`) and the high-volume ones (`subagent.delta`,
   * `subagent.tool`, `subagent.progress`) reach the parent differently. The id is accepted in either spelling this
   * project already uses for a child — the delegation's task id (`subagent.delta`, `subagent.tool`) or the
   * child's session id (`subagent.progress`) — because a reader that had to know which frame carries which name
   * would be one edit away from arming nothing.
   *
   * The caller decides which frames are progress, not this method: a frame that says nothing about *work* must
   * not re-arm anything, and the frame that reports a running clock is the one that matters most there.
   */
  progress(
    id: string,
    usage?: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>,
  ): void {
    if (!id) return;
    const scheduled = this.scheduled.find(
      (task) => task.active && (task.id === id || task.summary.sessionId === id),
    );
    if (!scheduled) return;
    const budget = this.deps.options.maxTokens;
    // Cached input is not counted, for the reason the child's own budget check gives (`run/child-turns.ts`).
    const spent = usage ? billableTokens(usage) : 0;
    if (budget > 0 && spent > budget && !scheduled.budgetController.signal.aborted) {
      scheduled.budgetController.abort(new Error(budgetMessage(budget)));
      return;
    }
    this.armStallWatchdog(scheduled);
  }
  private async execute(scheduled: ScheduledSubAgent): Promise<void> {
    const { summary } = scheduled;
    /**
     * The run can end while this task is still queued behind the cap. Reaping it here rather than after
     * a spawn keeps the promise that a cancelled task leaves nothing behind — not even an empty child
     * session that would show up in `reconcileChildRuns` on the next start.
     */
    if (scheduled.controller.signal.aborted || this.deps.signal.aborted) {
      this.cancelScheduled(scheduled);
      return;
    }
    this.armStallWatchdog(scheduled);
    /**
     * The child stops on any of four signals: the parent run, the caller's own cancellation (a correction that
     * gave up waiting, a cancelled tool call), this coordinator reaping it because the run ended without
     * collecting it, or the stall watchdog after the child went silent.
     *
     * The first two are cooperative and were always here. The watchdog is the one that has to exist: `settle()`
     * runs in the parent run's `finally` and joins every child, so a child that never settles would leave the
     * parent's run open — session locked, no later turn able to start — which is the failure this bounds.
     */
    const signal = AbortSignal.any([
      this.deps.signal,
      scheduled.stallController.signal,
      scheduled.budgetController.signal,
      scheduled.controller.signal,
    ]);
    let outcome: SubAgentOutcome;
    try {
      /**
       * The directory is allocated immediately before the child starts, from the baseline this call froze.
       *
       * Allocating here rather than at schedule time is what keeps a batch that is cancelled before dispatch from
       * creating directories nothing will use; allocating it from the *batch* rather than from a fresh freeze is
       * what keeps a child that waited for a slot on the same bytes as the ones that did not.
       */
      if (scheduled.batch && !scheduled.binding && scheduled.admitted) {
        scheduled.binding = await scheduled.batch.forTask(scheduled.admitted);
      }
      outcome = await scheduled.provider.start({
        provider: scheduled.provider.name,
        task: {
          id: scheduled.id,
          index: scheduled.index,
          role: scheduled.role,
          objective: scheduled.objective,
          ...(scheduled.context ? { context: scheduled.context } : {}),
          ...(scheduled.schema ? { schema: scheduled.schema } : {}),
        },
        ...(scheduled.binding ? { binding: scheduled.binding } : {}),
        parent: this.deps.parent,
        options: scheduled.options,
        signal,
        started: (sessionId) => {
          summary.sessionId = sessionId;
          this.deps.emit('subagent.started', {
            id: scheduled.id,
            index: scheduled.index,
            role: scheduled.role,
            objective: scheduled.objective,
            childSessionId: sessionId,
            total: scheduled.total,
          });
        },
      });
    } catch (error) {
      outcome = {
        sessionId: summary.sessionId,
        status: signal.aborted ? 'cancelled' : 'failed',
        text: '',
        rounds: 0,
        toolCalls: 0,
        usage: { ...EMPTY_USAGE },
        error: error instanceof Error ? error.message : String(error),
      };
    }
    summary.sessionId = outcome.sessionId || summary.sessionId;
    summary.status = outcome.status;
    summary.rounds = outcome.rounds;
    summary.toolCalls = outcome.toolCalls;
    summary.usage = outcome.usage;
    if (outcome.report) summary.report = outcome.report;
    // A custom-schema answer is kept on the scheduled task and not on the summary: the card, the durable
    // `subagent.finished` payload and the settlement notice all have one shape each, and making that shape
    // polymorphic would push a caller's object into every reader of a child's outcome.
    if (outcome.data !== undefined) scheduled.data = outcome.data;
    // Kept on the scheduled task rather than the summary: how much of the parent's transcript the child
    // inherited is a fact about this call, not part of the card the desktop renders.
    if (outcome.seeded) scheduled.seed = outcome.seeded;
    /**
     * Bounded where it is *set*, so every reader sees the same failure.
     *
     * There are four: the rendered report the parent model reads, the `RunResult` this run reports (`--json`, the
     * wire, the settlement), the durable `subagent.finished` record, and the desktop's card. Three of them copied
     * whatever this field held — the record cut it to 600 and the others did not — so a child whose endpoint failed
     * with a long error body handed a model, a client and a log three different amounts of the same sentence. The
     * bound belongs here, at the one place the value is decided.
     */
    const failure = scheduled.stallController.signal.aborted
      ? stallMessage(this.deps.options.timeoutMs)
      : scheduled.budgetController.signal.aborted
        ? budgetMessage(this.deps.options.maxTokens)
        : scheduled.controller.signal.aborted
          ? cancellationReason(scheduled, this.deps.signal.aborted)
          : outcome.error;
    summary.error = boundedError(failure);
    if (signal.aborted) summary.status = 'cancelled';
    else if (summary.error && summary.status === 'completed') summary.status = 'failed';
    scheduled.text = outcome.text;
    this.disarmStallWatchdog(scheduled);
    this.deps.onUsage(outcome.usage);
    this.deps.emit('subagent.finished', {
      ...summary,
      index: scheduled.index,
      total: scheduled.total,
      // Bounded, because the event stream is a progress feed: the untruncated report is in the tool
      // result and in the child session, which is where a reader should go for the whole thing.
      text: outcome.text.slice(0, 4000),
    });
  }
  /** The tool that reads back what background tasks produced. */
  collectTool(): Tool {
    const defaultWaitMs = this.deps.options.collectWaitMs;
    return {
      name: 'collect_subagents',
      description:
        'Read the reports of sub-agents you started with `delegate_task({wait: false})`. Each report is returned once: collecting marks it delivered, and the response lists the ids that are still running. ' +
        `If tasks are still running this call waits for them for up to ${defaultWaitMs} ms instead of returning immediately, so there is no reason to poll in a loop, and no reason to run commands just to pass the time. ` +
        `Set \`waitMs: 0\` to get the current state at once, or a larger value (up to ${SUBAGENT_CEILINGS.collectWaitMs}) to wait longer. This also returns the reports of sub-agents that settled in an earlier turn of this session and were never collected, so it is the way to pick up background work after a run has ended; a sub-agent still working when your run ends is stopped, and you are told about it at the start of your next turn. It also reports messages you sent to a sub-agent that were accepted but never delivered — send those again.`,
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            maxItems: 16,
            items: { type: 'string', maxLength: 64 },
            description:
              'Only collect these sub-agents, named by their task id or their child session id; omit to collect everything finished.',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: SUBAGENT_CEILINGS.collectWaitMs,
            description: `How long to wait for running tasks to finish, up to ${SUBAGENT_CEILINGS.collectWaitMs} ms. Defaults to ${defaultWaitMs}; 0 returns without waiting.`,
          },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;
          const wanted = ids ? new Set(ids.map((id) => String(id))) : undefined;
          const requested = args.waitMs === undefined ? defaultWaitMs : Number(args.waitMs);
          const waitMs = Number.isFinite(requested)
            ? Math.min(Math.max(0, Math.trunc(requested)), SUBAGENT_CEILINGS.collectWaitMs)
            : defaultWaitMs;
          const results = await this.collectWaiting(wanted, waitMs, context.signal);
          /**
           * Undelivered messages are read from the log, not from this run.
           *
           * A message that never reached its child is exactly the kind of thing that outlives the run that
           * accepted it: the process can stop, the run row close, and the parent come back to a session where
           * the only trace is in the log. Narrowing follows the same rule as the reports — an explicit `ids`
           * list selects the children it names, in either spelling.
           */
          const inbox = (this.deps.inbox?.() ?? []).filter((entry) =>
            isSelected(wanted, entry.childId, entry.childSessionId),
          );
          if (!results.reports.length && !results.running.length && !inbox.length)
            return { isError: false, content: 'No outstanding sub-agents.' };
          const blocks: string[] = [];
          if (results.reports.length) {
            blocks.push(
              report(
                results.reports,
                results.reports.map((entry) => ({ objective: entry.summary.objective })),
              ).content,
            );
          }
          if (results.running.length)
            blocks.push(
              `Still running after waiting ${waitMs} ms (${results.running.length}): ${results.running.join(', ')}. They keep working while you continue; collect again for their reports, and collect before you finish because they are cancelled when this run ends.`,
            );
          if (inbox.length) blocks.push(inboxNotice(inbox));
          return { isError: false, content: blocks.join('\n\n') };
        } catch (error) {
          return failure(error);
        }
      },
    };
  }
  /**
   * Collects now, or waits first when there is something to wait for.
   *
   * The wait ends on the first of: every awaited task settled, the window elapsed, the call was
   * cancelled, or the user sent a correction. Cancellation matters because a Stop must never be
   * swallowed by a poll; the correction case matters because it is what lets the window be long enough
   * to actually cover a slow child without holding the user's next instruction hostage.
   */
  private async collectWaiting(
    wanted: Set<string> | undefined,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ reports: SubAgentResult[]; running: string[] }> {
    const immediate = this.collect(wanted);
    if (waitMs <= 0 || immediate.reports.length || !immediate.running.length) return immediate;
    const pending = this.scheduled
      .filter((task) => !task.done && isSelected(wanted, task.id, task.summary.sessionId))
      .map((task) => task.promise);
    if (!pending.length) return immediate;
    // The poll is disposed in the `finally` because any of the other three branches can win, and a poll left
    // running would keep reading `steerPending` for the rest of the process's life.
    const steer = this.deps.steerPending ? whenTrue(this.deps.steerPending) : undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        delay(waitMs),
        abortSignal(signal),
        steer?.promise ?? NEVER,
      ]);
    } finally {
      steer?.dispose();
    }
    return this.collect(wanted);
  }
  /**
   * Reports that are finished and not yet delivered, plus the ids still running. Delivering marks them,
   * so a poll loop cannot grow the parent's context by re-reading the same report.
   */
  private collect(wanted?: Set<string>): { reports: SubAgentResult[]; running: string[] } {
    const reports: SubAgentResult[] = [];
    const running: string[] = [];
    /**
     * Every outcome handed over here is recorded as delivered, whoever it came from.
     *
     * Delivery has to be durable as well as in-memory: the in-memory flag only stops *this* run from handing
     * the same report over twice, while the reminder the parent gets on its next request is computed from the
     * log — a report delivered here but not written down would be announced again as if it had never arrived.
     */
    const delivered: string[] = [];
    for (const task of this.scheduled) {
      if (!isSelected(wanted, task.id, task.summary.sessionId)) continue;
      if (!task.done) running.push(task.id);
      else if (!task.collected) {
        task.collected = true;
        reports.push({
          summary: task.summary,
          text: task.text,
          ...(task.seed ? { seed: task.seed } : {}),
          ...(task.data !== undefined ? { data: task.data } : {}),
        });
        delivered.push(task.id);
      }
    }
    /**
     * Then the children of earlier runs.
     *
     * `collect_subagents` is the documented way to read background results, and after a run boundary the
     * coordinator that held them is gone: without this the same call answers "no outstanding sub-agents" while
     * a finished child's report sits unread in its own session. These come from the parent's log, so this is
     * the one place where the tool's answer is durable rather than in-memory.
     */
    for (const notice of this.deps.settlements?.() ?? []) {
      if (!isSelected(wanted, notice.id, notice.childSessionId)) continue;
      if (this.scheduled.some((task) => task.id === notice.id)) continue;
      reports.push({
        summary: {
          id: notice.id,
          sessionId: notice.childSessionId,
          role: notice.role,
          objective: notice.objective,
          status: notice.status === 'interrupted' ? 'failed' : notice.status,
          // Zeroed, not guessed: the durable settlement kept the report and the usage, but a round count and a
          // call count are facts about the child's run, and inventing them here would put numbers in the
          // parent's context that no record supports. The child's own run row carries the real ones.
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(notice.report ? { report: notice.report } : {}),
          ...(notice.reason ? { error: notice.reason } : {}),
        },
        // The text is empty on purpose: the durable record keeps the report, and the child's own transcript
        // is where its prose lives (`job_output` reads exactly that).
        text: '',
      });
      delivered.push(notice.id, notice.childSessionId);
    }
    if (delivered.length) this.deps.collected?.(delivered);
    return { reports, running };
  }
  /**
   * Ends this run's ownership of its sub-agents.
   *
   * A background child must not outlive the run: the run row is already finalised, so its usage would be
   * unattributed, and the tool registry it borrowed is about to be closed. Cancelling first and awaiting
   * afterwards is what makes that guarantee real rather than likely — the child's own signal handling
   * still decides how quickly it stops.
   */
  async settle(): Promise<void> {
    for (const task of this.scheduled) if (!task.done) task.controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }
  /** Records a task that was reaped before it could start, so nothing is left reporting as running. */
  private cancelScheduled(scheduled: ScheduledSubAgent): void {
    const { summary } = scheduled;
    scheduled.done = true;
    scheduled.text = '';
    // Nothing to release: a child that never ran cost nothing, and the slot it would have used was never
    // taken (a cancelled task is reaped before the semaphore admits it).
    summary.status = 'cancelled';
    summary.error = cancellationReason(scheduled, this.deps.signal.aborted);
    scheduled.settleTask();
    this.deps.emit('subagent.finished', {
      ...summary,
      index: scheduled.index,
      total: scheduled.total,
      text: '',
    });
  }
}
