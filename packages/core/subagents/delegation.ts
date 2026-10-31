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
 * Why a child was stopped by its own controller: the call that started it, or the run ending around
 * it.
 */
function cancellationReason(scheduled: ScheduledSubAgent, runAborted: boolean): string {
  // A cancelled run cancels the tool call inside it too; the run is the cause then, not the call.
  return scheduled.callerStopped && !runAborted
    ? 'Cancelled: the call that started this sub-agent was stopped or ran out of time'
    : 'Cancelled: the run that started this sub-agent ended without collecting it';
}

/**
 * Sub-agent delegation: a bounded fan-out to child runs, each with a private session, so a side
 * investigation costs the parent one report instead of a transcript. Everything is capped because
 * agents spawning agents spend the user's money.
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
   * The parent's read-only promise was lifted (plan approved mid-run), so children may write too.
   * One way only: approvals cannot be undone.
   */
  promoteToWritable(): void {
    if (!this.deps.readOnly) return;
    this.deps = { ...this.deps, readOnly: false };
  }
  get summaries(): SubAgentSummary[] {
    return this.records.map((record) => ({ ...record }));
  }
  /**
   * The tool the parent model calls. Needs no approval: every effect a child makes goes through the
   * parent's approver.
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
   * The same delegation for a child that continues this conversation. A separate tool because
   * inheriting the parent's history is a different promise from a fresh, briefed child.
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
   * The models a task may run on, as this host serves them. Registered only when the host supplied
   * the list.
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
       * Freeze the batch's baseline once: after validation (so a refused task leaves no snapshot)
       * and before scheduling (so queued children see the same bytes as the first).
       */
      const batch = await this.deps.workspaceForBatch?.({ tasks, signal });
      const scheduled = tasks.map((task, index) => this.schedule(task, index, tasks.length, batch));
      /**
       * The call's cancellation reaches the children it admitted, and only for the call's lifetime.
       * A cut-off call must not leave uncollected work running; the listener is removed in
       * `finally` so `wait: false` can hand work off, while the run's own end still stops children.
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
          // Not awaited, which is the point of `wait: false`; `settle()` still joins them at run
          // end.
          for (const task of scheduled) void this.run(task);
          return { isError: false, content: startedNotice(scheduled) };
        }
        /**
         * A blocking call stops waiting when the user sends a correction. Children keep running and
         * the call degrades to "started, collect later".
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
        // Reports returned in the result count as collected, so the parent is not reminded about
        // them.
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
  /** The read-only and per-run guards, shared by both entry points. */
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
    // Validate capabilities before scheduling: a provider that cannot honour an option must refuse,
    // and nothing has been created yet.
    for (const task of tasks)
      this.deps.providers.resolve(this.providerFor(task), this.requestOptions(task));
    return tasks;
  }
  /**
   * The provider for this task: the one it named, or the run's own. Shared so validation and
   * scheduling agree.
   */
  private providerFor(task: AdmittedTask): string {
    return task.provider ?? this.deps.provider;
  }
  /**
   * What one task asks the provider for. Only genuinely needed capabilities are requested, so
   * providers are not refused for no reason.
   */
  private requestOptions(task: AdmittedTask): SubAgentRequestOptions {
    const provider = this.deps.providers.resolve(this.providerFor(task), {});
    return {
      ...(task.model ? { agentOptions: { model: task.model } } : {}),
      /**
       * Request structured output only when the task declared its own `schema`. The fixed report
       * contract is composed by the coordinator, so out-of-process providers without
       * `submit_report` still qualify.
       */
      ...(task.schema !== undefined
        ? { outputSchema: task.schema }
        : provider.capabilities.includes('outputSchema')
          ? { outputSchema: REPORT_SCHEMA }
          : {}),
      maxDepth: this.deps.options.maxDepth,
      ...(task.role === 'explore' ? { toolFilter: [...EXPLORE_TOOLS] } : {}),
      /** Request isolation only for `worktree`; `shared` is what every provider already does. */
      ...(task.workspaceMode === 'worktree' ? { workspace: 'worktree' as const } : {}),
      /**
       * Only a caller-supplied persona goes here. The role prompt goes to
       * `AgentOptions.rolePrompt`, which is additive; a persona would replace the harness's
       * identity paragraph.
       */
      ...(task.persona ? { persona: task.persona } : {}),
      // Only asked for when it is wanted, so a provider that cannot fork is still usable for everything else.
      ...(task.fork ? { contextFork: true } : {}),
    };
  }
  /**
   * Takes on one task (identity, provider, record) before anyone waits for it; `wait: false`
   * depends on this being separate from running. The per-run total is checked in `admit`; the
   * semaphore bounds concurrency.
   */
  private schedule(
    task: AdmittedTask,
    index: number,
    total: number,
    batch?: BatchWorkspace,
  ): ScheduledSubAgent {
    const id = randomUUID();
    const options = this.requestOptions(task);
    // Resolve the provider at schedule time: with `wait: false` nobody watches the dispatch.
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
   * Runs one child to completion for a non-tool caller (workflow scripts), through the same
   * admission, semaphore and execution so the caps still apply. Marked delivered once its answer is
   * handed over.
   */
  async runOne(
    task: { objective: string; context?: string; model?: string; schema?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<SubAgentAnswer> {
    const [admitted] = this.admit([task], 1, false);
    const scheduled = this.schedule(admitted!, 0, 1);
    /** Propagate the caller's cancellation (e.g. a workflow tool's deadline) into the child. */
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
      // A structured child often ends with no prose; its submitted report is the answer.
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
      // Provider failures are outcomes; later failures belong to settlement, kept on the task for
      // every caller.
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
      // Every exit from `execute` clears the watchdog timer and resets `active`, which `progress`
      // reads. Otherwise a resident child's later turns would keep arming timers that hold the
      // process open.
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
   * Starts or restarts this child's stall watchdog. Not unref'd: it is what keeps a wedged child
   * from holding the parent run open forever. Zero disables it (`SubAgentOptions.timeoutMs`).
   */
  private armStallWatchdog(scheduled: ScheduledSubAgent): void {
    this.disarmStallWatchdog(scheduled);
    scheduled.active = true;
    if (this.deps.options.timeoutMs <= 0) return;
    scheduled.stallTimer = setTimeout(() => {
      // Abort only the stall controller; `scheduled.controller` means run-end reaping and would
      // misreport the cause.
      scheduled.stallController.abort(new Error(stallMessage(this.deps.options.timeoutMs)));
    }, this.deps.options.timeoutMs);
  }
  private disarmStallWatchdog(scheduled: ScheduledSubAgent): void {
    if (scheduled.stallTimer === undefined) return;
    clearTimeout(scheduled.stallTimer);
    scheduled.stallTimer = undefined;
  }
  /**
   * The child showed progress, so its watchdog restarts. Called from the parent's `emit`, the one
   * seam both frame paths pass through. Accepts the task id or the child session id. The caller
   * decides which frames count as progress.
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
     * Reap a task cancelled while queued, so it leaves nothing behind, not even an empty child
     * session.
     */
    if (scheduled.controller.signal.aborted || this.deps.signal.aborted) {
      this.cancelScheduled(scheduled);
      return;
    }
    this.armStallWatchdog(scheduled);
    /**
     * The child stops on the parent run's signal, the caller's cancellation, run-end reaping, or
     * the stall watchdog. The watchdog is required because `settle()` joins every child in the
     * parent's `finally`.
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
       * Allocate the directory just before the child starts, from the batch baseline, so a
       * cancelled batch creates none and late children see the same bytes.
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
    // Custom-schema answers stay on the scheduled task so the summary, `subagent.finished` and
    // notices keep one shape.
    if (outcome.data !== undefined) scheduled.data = outcome.data;
    // Transcript inheritance is a fact about this call, not part of the card.
    if (outcome.seeded) scheduled.seed = outcome.seeded;
    /**
     * Bound the failure text once here, so the model, `RunResult`, the durable record and the card
     * agree.
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
      // The progress feed is bounded; the full report is in the tool result and the child session.
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
           * Undelivered messages are read from the log, since they can outlive the run that
           * accepted them. `ids` narrows by either id spelling.
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
   * Collects now, or waits first. The wait ends when awaited tasks settle, the window elapses, the
   * call is cancelled, or the user sends a correction.
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
    // Dispose the poll in `finally`, since any branch can win.
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
   * Finished, undelivered reports plus the ids still running. Delivery marks them so polling does
   * not repeat reports.
   */
  private collect(wanted?: Set<string>): { reports: SubAgentResult[]; running: string[] } {
    const reports: SubAgentResult[] = [];
    const running: string[] = [];
    /** Record delivery durably: the parent's reminder is computed from the log. */
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
     * Then the children of earlier runs, read from the parent's log, so `collect_subagents` still
     * finds reports after a run boundary.
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
          // Zero, not guessed; the child's own run row has the real counts.
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(notice.report ? { report: notice.report } : {}),
          ...(notice.reason ? { error: notice.reason } : {}),
        },
        // Empty on purpose: the report is in the durable record, the prose in the child's
        // transcript (`job_output`).
        text: '',
      });
      delivered.push(notice.id, notice.childSessionId);
    }
    if (delivered.length) this.deps.collected?.(delivered);
    return { reports, running };
  }
  /**
   * Ends this run's ownership of its sub-agents. A background child must not outlive the run, so
   * cancel first and then await.
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
    // Nothing to release: a reaped task never took a slot.
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
