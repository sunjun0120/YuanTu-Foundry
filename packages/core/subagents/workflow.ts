/**
 * `workflow`: a script that orchestrates sub-agents within one tool call. The script is an async
 * function body; `agent('...')` runs a sub-agent and resolves to its report, `parallel`/`pipeline`
 * fan out, and `return` is the answer. This saves a model round per step for multi-step delegation.
 *
 * 1. `agent()` goes through the same coordinator, admission count and semaphore as `delegate_task`;
 *    no extra budget.
 * 2. It uses the same process runner as `run_code`, so the call's deadline stops a runaway script.
 *    Direct effects depend on the OS backend.
 * 3. A failed `agent()` throws inside the script, which decides how to handle it.
 * 4. Misuse (unknown hook, bad prompt, unsupported option, one child too many) kills the script, so
 *    a script written for a newer host fails loudly.
 */
import { startCodeProcess } from '../../tools/code-process.ts';
import { errorText, runLevelFailure, summarise } from '../../tools/run-code.ts';
import type { CallRequest, CodeWorkerData, WorkerMessage } from '../../tools/code-worker.ts';
import type { SubAgentTaskStatus, Tool, ToolResult } from '../../protocol/index.ts';
import type { SubAgentAnswer } from './delegation.ts';

export const WORKFLOW = 'workflow';
/**
 * What one workflow may do. The agent cap is enforced on the first call that exceeds it, killing
 * the script rather than truncating the fan-out.
 */
export const WORKFLOW_CEILINGS = {
  maxAgents: 24,
  maxCode: 20_000,
  maxPhases: 32,
  maxPromptChars: 8_000,
  maxNameChars: 80,
  maxTraceEntries: 40,
  maxTraceText: 160,
  /**
   * How long a finished workflow waits for the sub-agents it started, so stopping the workflow
   * stops their work too. Bounded because children have their own watchdogs; the parent run's
   * `settle()` is the final join.
   */
  teardownMs: 30_000,
} as const;
/** What one `agent()` call resolves to, as the workflow's result reports it. */
export interface WorkflowDeps {
  /**
   * Runs one sub-agent to completion; supplied by the coordinator so caps and events match
   * `delegate_task`.
   */
  runAgent: (
    prompt: string,
    options: { model?: string; schema?: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<SubAgentAnswer>;
  /**
   * The run's own per-run sub-agent total, when lower than the workflow ceiling, so the script is
   * told the real limit. The coordinator still enforces what is left.
   */
  maxAgents?: number;
  /**
   * The deployment's default tool budget, applied when a call states no `timeoutMs`. The registry
   * exempts `workflow` from that default, so the tool applies it itself.
   */
  defaultTimeoutMs?: () => number | undefined;
  /** Tests only: see `CodeWorkerData.exposeProcessForTests`. The coordinator never sets it. */
  exposeProcessForTests?: boolean;
}
/** The options `agent()` accepts. A key outside this set is refused rather than ignored. */
const AGENT_OPTION_KEYS = new Set(['model', 'schema']);
/** One `agent()` call, as the trace and the phase summary report it. */
interface AgentCall {
  phase: string | null;
  prompt: string;
  status?: SubAgentTaskStatus;
  sessionId?: string;
  rounds?: number;
  error?: string;
}
export function workflowTool(deps: WorkflowDeps): Tool {
  const maxAgents = Math.min(
    WORKFLOW_CEILINGS.maxAgents,
    deps.maxAgents ?? WORKFLOW_CEILINGS.maxAgents,
  );
  return {
    name: WORKFLOW,
    cancellationGraceMs: 35000,
    description:
      'Run a script that orchestrates sub-agents, instead of fanning out with one `delegate_task` per step. ' +
      '`code` is the body of an async function: `await agent("…")` runs one sub-agent and resolves to what it reported; ' +
      '`agent("…", { schema })` holds that sub-agent to the JSON Schema you pass, and resolves to the object it came back with (validated before it reaches you); ' +
      '`parallel([() => agent(a), () => agent(b)])` runs several at once, with a failing one resolving to null; ' +
      '`pipeline(items, …stages)` runs every item through the stages in order with no barrier between them, dropping an item that throws; ' +
      '`phase("name")` labels the calls that follow; `log(…)` writes to this result; `args` is the data you passed in. ' +
      'Return a value and it becomes this call’s result. Use it for work with steps or many similar sub-tasks; for a single delegation use `delegate_task`. ' +
      `A workflow may start at most ${maxAgents} sub-agents, shared with any \`delegate_task\` calls in this run, and the whole script runs under this call’s deadline. ` +
      'This is not the scheduled-task feature: nothing here runs later or on a timer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          maxLength: WORKFLOW_CEILINGS.maxNameChars,
          description: 'A short label for this workflow, used in its result.',
        },
        code: {
          type: 'string',
          minLength: 1,
          maxLength: WORKFLOW_CEILINGS.maxCode,
          description:
            'The body of an async function. Its API is `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` and `console`. It runs in a separate Node process; direct filesystem and network restrictions depend on the selected backend.',
        },
        args: {
          type: 'object',
          description: 'Data for the script, handed to it as the frozen `args` value.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          maximum: 3_600_000,
          description:
            'Optional: how long the whole script may run, in milliseconds. `0` means no deadline — use it when the work is a real fan-out whose length is set by the sub-agents rather than by you. Omitting it leaves the deployment default.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const code = String(args.code);
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      /**
       * How long this call may run: `timeoutMs` bounds the whole script, `0` means no deadline,
       * omitted uses the deployment default. A script's length is set by its children's work.
       */
      const requestedTimeout = args.timeoutMs;
      if (
        requestedTimeout !== undefined &&
        (!Number.isSafeInteger(requestedTimeout) || (requestedTimeout as number) < 0)
      )
        return {
          isError: true,
          content: 'timeoutMs must be a non-negative integer (0 = no deadline).',
        };
      const timeoutMs =
        requestedTimeout === undefined ? deps.defaultTimeoutMs?.() : (requestedTimeout as number);
      const worker = await startCodeProcess(
        {
          code,
          kind: 'workflow',
          names: ['agent', 'phase'],
          args: args.args ?? null,
          ...(deps.exposeProcessForTests ? { exposeProcessForTests: true } : {}),
          /**
           * Ceilings travel into the script so its checks can throw synchronously; the host
           * re-checks every one and is the authority.
           */
          limits: {
            maxAgents,
            maxPromptChars: WORKFLOW_CEILINGS.maxPromptChars,
            maxNameChars: WORKFLOW_CEILINGS.maxNameChars,
            maxPhases: WORKFLOW_CEILINGS.maxPhases,
          },
        } satisfies CodeWorkerData,
        context,
      );
      const calls: AgentCall[] = [];
      const phases: string[] = [];
      let currentPhase: string | null = null;
      const started = performance.now();
      /**
       * This call's own cancellation, composed with the run's. Children get both signals
       * (`AbortSignal.any`), so a deadline or an unawaited final `agent()` stops them, and Stop
       * still does too.
       */
      const call = new AbortController();
      const childSignal = AbortSignal.any([context.signal, call.signal]);
      return await new Promise<ToolResult>((resolve, reject) => {
        let settled = false;
        /** The `agent()`/`phase()` handlers still in flight, so `finish` can wait for them to unwind. */
        const inFlight = new Set<Promise<void>>();
        /** Ends the call exactly once: the worker is stopped, the listener removed, then the promise settles. */
        const finish = (error?: unknown, result?: ToolResult) => {
          if (settled) return;
          settled = true;
          if (error instanceof Error && error.name === 'ProgramDisconnectedError') {
            error.message += '\n[Known workflow calls]\n' + JSON.stringify(calls).slice(0, 8000);
            if (inFlight.size) error.name = 'ToolCleanupError';
          }
          context.signal.removeEventListener('abort', abort);
          if (deadline !== undefined) clearTimeout(deadline);
          /**
           * Children stop with the call, and the caller hears only once they have. `settle` is
           * separate from `finish` because `finish` may be called from a handler being waited on.
           */
          call.abort(error instanceof Error ? error : new Error('the workflow call is over'));
          const unwinding = [...inFlight];
          void (async () => {
            await worker.terminate();
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              Promise.allSettled(unwinding),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, WORKFLOW_CEILINGS.teardownMs);
                timer.unref?.();
              }),
            ]);
            clearTimeout(timer);
            if (inFlight.size) {
              const unknown = new Error(
                'Workflow child outcomes are unknown; inspect their sessions before retrying',
              );
              unknown.name = 'ToolCleanupError';
              throw unknown;
            }
            if (error) reject(error);
            else resolve(result!);
          })().catch(reject);
        };
        const abort = () => finish(context.signal.reason ?? new Error('workflow was cancelled'));
        context.signal.addEventListener('abort', abort, { once: true });
        /**
         * The caller's deadline, unless `0` ("no deadline"). Unref'd so it cannot keep a finished
         * process alive.
         */
        const deadline =
          timeoutMs === undefined || timeoutMs === 0
            ? undefined
            : setTimeout(() => {
                finish(
                  new Error(
                    `workflow exceeded its ${timeoutMs}ms budget and was stopped. Known child results remain in their sessions and program journal; unfinished children are stopped, and uncertain effects require inspection before retrying. Raise timeoutMs or pass 0 to let the script finish.`,
                  ),
                );
              }, timeoutMs);
        deadline?.unref?.();
        const reply = (id: number, outcome: { ok: boolean; content: string }) => {
          if (settled) return;
          worker.postMessage({ type: 'call-result', id, ...outcome });
        };
        /** Records a misuse as the script's death, the same way a thrown hook would. */
        const misuse = (id: number, message: string) => reply(id, { ok: false, content: message });
        const handleHook = async (message: CallRequest): Promise<void> => {
          const hookArgs = (message.args ?? {}) as Record<string, unknown>;
          if (message.name === 'phase') return handlePhase(message.id, hookArgs);
          if (message.name !== 'agent')
            return misuse(
              message.id,
              `Unknown workflow hook "${message.name}": this host serves agent() and phase().`,
            );
          const prompt = typeof hookArgs.prompt === 'string' ? hookArgs.prompt.trim() : '';
          if (!prompt) return misuse(message.id, 'agent() needs a non-empty prompt string.');
          if (prompt.length > WORKFLOW_CEILINGS.maxPromptChars)
            return misuse(
              message.id,
              `agent() prompt is longer than ${WORKFLOW_CEILINGS.maxPromptChars} characters.`,
            );
          const options = (hookArgs.options ?? {}) as Record<string, unknown>;
          const unsupported = Object.keys(options).filter((key) => !AGENT_OPTION_KEYS.has(key));
          if (unsupported.length)
            return misuse(
              message.id,
              `agent() does not accept ${unsupported.join(', ')} on this host; it supports: ${[...AGENT_OPTION_KEYS].join(', ')}.`,
            );
          const model = typeof options.model === 'string' ? options.model.trim() : '';
          const schema = options.schema as Record<string, unknown> | undefined;
          // Count before the call, so a `parallel` cannot pass the cap many times at once.
          if (calls.length >= maxAgents)
            return misuse(
              message.id,
              `This workflow has already started ${calls.length} sub-agents, which is its limit; no further agent() call is accepted.`,
            );
          const call: AgentCall = { phase: currentPhase, prompt: summarise(prompt) };
          calls.push(call);
          try {
            const result = await deps.runAgent(
              prompt,
              { ...(model ? { model } : {}), ...(schema ? { schema } : {}) },
              childSignal,
            );
            call.status = result.status;
            call.sessionId = result.sessionId;
            call.rounds = result.rounds;
            context.programJournal?.record(
              {
                id: `${context.callId ?? WORKFLOW}#${message.id}`,
                name: 'workflow.agent',
                arguments: hookArgs,
              },
              'known',
              {
                isError: result.status !== 'completed',
                content: result.answer,
              },
            );
            if (result.status !== 'completed') {
              call.error = result.error ?? `the sub-agent finished with status ${result.status}`;
              return reply(message.id, { ok: false, content: call.error });
            }
            if (schema) {
              /** A schema was requested, so an answer that is not that object is a failure. */
              if (result.data === undefined)
                return reply(message.id, {
                  ok: false,
                  content:
                    'the sub-agent finished without submitting the object this task asked for (it may have run out of rounds)',
                });
              return reply(message.id, { ok: true, content: JSON.stringify(result.data) });
            }
            reply(message.id, { ok: true, content: result.answer });
          } catch (error) {
            context.programJournal?.record(
              {
                id: `${context.callId ?? WORKFLOW}#${message.id}`,
                name: 'workflow.agent',
                arguments: hookArgs,
              },
              'unknown',
            );
            if (runLevelFailure(error, context.signal)) {
              // Deferred approvals, cleanup failures and cancellation are the run speaking; the
              // script must not catch them.
              finish(error);
              return;
            }
            call.status = 'failed';
            call.error = errorText(error);
            reply(message.id, { ok: false, content: call.error });
          }
        };
        const handlePhase = (id: number, hookArgs: Record<string, unknown>): void => {
          const title = typeof hookArgs.title === 'string' ? hookArgs.title.trim() : '';
          if (!title) return misuse(id, 'phase() needs a non-empty title string.');
          if (title.length > WORKFLOW_CEILINGS.maxNameChars)
            return misuse(
              id,
              `phase() title is longer than ${WORKFLOW_CEILINGS.maxNameChars} characters.`,
            );
          if (phases.length >= WORKFLOW_CEILINGS.maxPhases)
            return misuse(
              id,
              `A workflow may declare at most ${WORKFLOW_CEILINGS.maxPhases} phases.`,
            );
          phases.push(title);
          currentPhase = title;
          reply(id, { ok: true, content: `phase ${title}` });
        };
        worker.once('error', (error) => finish(error));
        worker.on('message', (message: WorkerMessage | CallRequest) => {
          if (settled) return;
          if (message.type === 'call') {
            // Tracked so `finish` can wait for handlers still awaiting a child.
            const running = handleHook(message);
            inFlight.add(running);
            void running.finally(() => inFlight.delete(running)).catch((error) => finish(error));
            return;
          }
          finish(
            undefined,
            workflowResult(message, { name, calls, phases }, performance.now() - started),
          );
        });
        if (context.signal.aborted) abort();
      });
    },
  };
}
/**
 * The script's answer, output and sub-agent calls. Per-call lines are shown for calls that did not
 * complete (including ones still running when the script returned), and for all calls when the
 * script failed.
 */
function workflowResult(
  message: WorkerMessage,
  run: { name: string; calls: readonly AgentCall[]; phases: readonly string[] },
  elapsedMs: number,
): ToolResult {
  const label = run.name ? ` "${run.name}"` : '';
  const parts: string[] = [];
  if (message.type === 'error') parts.push(`workflow${label} failed: ${message.message}`, '');
  else parts.push(message.value.trim() ? message.value : '(the workflow returned no value)');
  if (message.logs.length) parts.push('', '[log]', ...message.logs);
  const failed = run.calls.filter((call) => call.status !== 'completed');
  const summary = workflowSummary(run, elapsedMs);
  if (message.type === 'error') {
    const shown = run.calls.slice(0, WORKFLOW_CEILINGS.maxTraceEntries);
    const more = run.calls.length - shown.length;
    parts.push(
      '',
      `[agents] ${summary}`,
      ...shown.map((call) => `  ${agentLine(call)}`),
      ...(more > 0 ? [`  …and ${more} more`] : []),
    );
  } else {
    parts.push('', `[agents] ${summary}`);
    for (const call of failed) parts.push(`  ${agentLine(call)}`);
  }
  return { isError: message.type === 'error', content: parts.join('\n') };
}
function workflowSummary(
  run: { calls: readonly AgentCall[]; phases: readonly string[] },
  elapsedMs: number,
): string {
  const counts = new Map<string, number>();
  for (const call of run.calls) {
    const key = call.phase ?? '(no phase)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // A still-running call counts here for the same reason it is listed above: nobody knows how it ended.
  const failed = run.calls.filter((call) => call.status !== 'completed').length;
  return (
    `${run.calls.length} sub-agent call(s) in ${Math.round(elapsedMs)}ms` +
    (failed ? `, ${failed} did not complete` : '') +
    (counts.size
      ? `; by phase: ${[...counts].map(([phase, count]) => `${phase}(${count})`).join(', ')}`
      : '')
  );
}
function agentLine(call: AgentCall): string {
  const phase = call.phase ? `[${call.phase}] ` : '';
  const status = call.status ?? 'failed';
  const detail =
    status === 'completed'
      ? `(${call.rounds ?? 0} round(s), session ${shortSession(call.sessionId)})`
      : `: ${summarise(call.error ?? 'did not finish')}`;
  return `${phase}${call.prompt} → ${status}${detail}`;
}
function shortSession(sessionId: string | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : 'none';
}
