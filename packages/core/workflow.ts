/**
 * `workflow`: a script that orchestrates sub-agents.
 *
 * Delegation as it exists is one call per child: `delegate_task({tasks:[…]})` fans out, `collect_subagents`
 * reads back. That is enough for "run these four investigations", and it is not enough for the shape the model
 * actually reaches for when the work has *steps*: sweep, then use what came back to decide what to look at
 * next, then write one answer from the pieces. Written as tool calls that shape costs a model round per step,
 * each round re-reading the whole transcript — and the branching has to be re-derived from prose every time.
 *
 * A workflow is that shape written down once. The script is the body of an async function; `agent('…')` runs a
 * sub-agent and resolves to what it reported, `parallel`/`pipeline` express the fan-out, and `return` is the
 * answer. The whole orchestration happens inside one tool call.
 *
 * Four decisions worth stating, because each one is a place this could have gone wrong:
 *
 * 1. **A script is not a second way to run agents.** `agent()` goes through the same coordinator, the same
 *    per-run admission count and the same concurrency semaphore as `delegate_task`, so a loop in a script cannot
 *    buy more children than the caps allow. The workflow tool adds no budget of its own.
 * 2. **It uses the same process runner as `run_code`.** Isolation and termination are one question — a script that
 *    loops forever must be stopped by the call's deadline exactly like a program, and two runners would be two
 *    answers to it. Only the injected RPC surface differs; direct effects depend on the selected OS backend.
 * 3. **A failed `agent()` throws inside the script.** The script's own `try`/`catch` (or a combinator) decides
 *    what to do about it, which is what makes `parallel`'s "a failing item becomes null" a *choice* the script
 *    makes rather than a behaviour hidden in the host.
 * 4. **Misuse is loud.** An unknown hook, a non-string prompt, an option this host does not implement, or one
 *    child too many all come back as an error that kills the script. This is deliberately not the same as the
 *    `run_code` tool's catalog check: here the names and options
 *    come from a *script* a model wrote against a documented API, and a script written for a newer host must
 *    fail rather than quietly skip the part this host does not have.
 */
import { startCodeProcess } from '../tools/code-process.ts';
import { errorText, runLevelFailure, summarise } from '../tools/run-code.ts';
import type { CallRequest, CodeWorkerData, WorkerMessage } from '../tools/code-worker.ts';
import type { SubAgentTaskStatus, Tool, ToolResult } from '../protocol/index.ts';
import type { SubAgentAnswer } from './subagents.ts';

export const WORKFLOW = 'workflow';
/**
 * What one workflow may do, however its script is written.
 *
 * The agent count is the important one: a workflow is a *program*, so "how many children can this create" cannot
 * be answered by reading the call — only by running it. The cap is enforced on the first call that would exceed
 * it, and the script dies there rather than being allowed to finish with a truncated fan-out.
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
   * How long a finished workflow waits for the sub-agents it had already started.
   *
   * Stopping the script is not stopping the children: a deadline used to `terminate()` the worker and hand the
   * caller its answer while the children the script had started kept running — their own runs, their own
   * sessions, their own spend — with nothing left that would ever collect what they said. The wait is what makes
   * "the workflow was stopped" mean the work stopped too, and it is bounded because the caller must not be held
   * open by a child that ignores its own cancellation: a child is an ordinary run with its own stall watchdog,
   * tool wall clocks and request deadlines, so one that outlives this bound is already being stopped by something
   * else. The parent run's own `settle()` is the final join, and it runs before the run can end.
   */
  teardownMs: 30_000,
} as const;
/** What one `agent()` call resolves to, as the workflow's result reports it. */
export interface WorkflowDeps {
  /**
   * Runs one sub-agent to completion. The coordinator supplies this, so the caps, the concurrency slot and the
   * events a workflow child produces are the same ones a `delegate_task` child produces.
   */
  runAgent: (
    prompt: string,
    options: { model?: string; schema?: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<SubAgentAnswer>;
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
      `A workflow may start at most ${WORKFLOW_CEILINGS.maxAgents} sub-agents, and the whole script runs under this call’s deadline. ` +
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
       * How long this call may run, when the caller says.
       *
       * The registry used to bound every workflow at the default tool budget, which is a **stopwatch on the script**
       * — and a script's length is set by its children's work, not by the call. A four-way investigation whose
       * children each take four minutes is a legitimate workflow that a ten-minute stopwatch kills with its
       * children, losing exactly the reports the parent asked for. That is the failure this tool is for, so the
       * budget is now the caller's to state: `timeoutMs` bounds the whole script, `0` means no deadline at all, and
       * omitting it leaves the deployment's default in place.
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
      const timeoutMs = requestedTimeout === undefined ? undefined : (requestedTimeout as number);
      const worker = await startCodeProcess(
        {
          code,
          kind: 'workflow',
          names: ['agent', 'phase'],
          args: args.args ?? null,
          /**
           * The ceilings travel into the script so its own checks can be synchronous.
           *
           * A refusal that arrives as a rejected promise is invisible to a script that forgot to `await`; a throw
           * is not. The host below re-checks every one of them, and that is where the authority is: only the host
           * knows how many children the *run* has left.
           */
          limits: {
            maxAgents: WORKFLOW_CEILINGS.maxAgents,
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
       * This call's own cancellation, composed with the run's.
       *
       * Until it existed, a workflow's deadline stopped the *script* and nothing else. `finish` terminated the
       * worker and answered the caller, while the children the script had already started — which were handed
       * `context.signal`, the one signal nobody was going to abort until the whole run ended — kept working:
       * spending tokens, writing to their sessions, and holding the run's concurrency slots for a call that had
       * already reported itself stopped. The same hole covered a script that returned without awaiting its last
       * `agent()`: its answer could not reach anybody, and it ran anyway.
       *
       * Children are started with both signals, so either one stops them: the run's own cancellation, and this
       * call being over. `AbortSignal.any` rather than passing this one alone, because a child must still stop
       * when the user presses Stop.
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
           * The children stop with the call, and the caller hears about it only once they have.
           *
           * `settle` is separate from `finish` because the wait is asynchronous: `finish` returns immediately —
           * it is called from inside a handler that may itself be one of the promises being waited for, and
           * blocking on that would deadlock the two. A call with nothing in flight settles on the spot, which is
           * the ordinary case.
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
         * The caller's deadline, when one was asked for and is not zero.
         *
         * `0` is the statement "no deadline", which is why it is tested rather than treated as a falsy value: the
         * two are different requests and a workflow that fans out over real work is exactly the case that asks for
         * the second. The timer is unref'd so a pending workflow budget cannot keep a finished process alive.
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
          // Counted before the call rather than after: a `parallel` of twenty agents must not be able to pass the
          // cap twenty times before any of them has finished.
          if (calls.length >= WORKFLOW_CEILINGS.maxAgents)
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
              /**
               * A schema was asked for, so an answer that is not that object is a failure, not a fallback.
               *
               * A child that stopped without submitting one (its own round limit, a cancelled run) would
               * otherwise reach the script as prose it never asked for and cannot use — and the script would have
               * to guess whether the shape it declared was honoured.
               */
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
              // A deferred approval, a cleanup failure or cancellation is the *run* speaking. Letting the script
              // catch that and carry on is the one thing an unattended run must not be able to do.
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
            // Tracked so `finish` can wait for it: a handler still awaiting a child is exactly what must not
            // outlive the call it belongs to.
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
 * The script's answer, what it printed, and which sub-agents it ran.
 *
 * Per-call lines are shown for the calls that did *not* complete, always, and for every call only when the script
 * itself failed. A workflow whose children all answered needs no inventory of them — the answers are in the
 * returned value, and the model wrote the calls — but a workflow that failed, or that quietly caught a failing
 * child, is exactly the case where "which step, and what did it say" is the whole question.
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
  const failed = run.calls.filter((call) => call.status && call.status !== 'completed');
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
  const failed = run.calls.filter((call) => call.status && call.status !== 'completed').length;
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
