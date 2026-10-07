/**
 * `run_code`: one round of model output can be a *program* that calls tools itself, instead of one tool call.
 *
 * Two problems share one lever. A run pays a round trip per tool call, so "read these eight files and tell me
 * which two disagree" costs eight model turns and eight request rebuilds; and every tool's full JSON schema is
 * sent on every request, so a catalog of sixty tools costs more context than the task. A program fixes the first;
 * folding the catalog into `run_code` plus a generated declaration list (`YUANTU_TOOL_MODE=ptc`) fixes the second.
 *
 * Four decisions are deliberate:
 *
 * - **A program gets no new powers.** It calls the tools the run already has, through the run's own registry:
 *   each inner call is validated, permission-checked, approved by a person where the tool requires it, journalled
 *   and bounded by its own deadline, exactly as if the model had asked for it directly. `run_code` carries no
 *   permission of its own for that reason — a program that only reads needs no approval, and one that writes
 *   triggers the write approval per call, which is also what a person sees.
 * - **The catalog is a seam, not a lookup.** The run supplies it (`ToolContext.catalog`), so a read-only child
 *   hands its program the child's trimmed list: a program cannot reach a tool the model itself could not see.
 * - **A failed call throws inside the program.** `try`/`catch` is then how a program handles an expected
 *   failure, and the failure text is the tool's own message rather than something invented here.
 * - **An independent process is not a complete sandbox.** A backend starts ordinary Node, whose worker limits
 *   the guest heap. VM globals and Node permission flags reduce accidental access, but neither protects against
 *   malicious code. Direct effects depend on the selected OS backend. Every RPC is validated against this run's
 *   catalog, and a disconnect during an inner call stops automatic continuation with an unknown outcome.
 */
import { startCodeProcess } from './code-process.ts';
import { parseSetting } from '../protocol/settings.ts';
import { DeferredApprovalError } from '../core/approval-deferred.ts';
import { BASE_DESCRIPTION, RUN_CODE } from './run-code-sdk.ts';
import type { ToolMode } from './run-code-sdk.ts';
import type { Tool, ToolCall, ToolResult } from '../protocol/index.ts';
import type { CallRequest, CodeWorkerData, WorkerMessage } from './code-worker.ts';

export { FOLDED_DESCRIPTION, RUN_CODE, toolSdk } from './run-code-sdk.ts';
export type { ToolMode } from './run-code-sdk.ts';

/** `YUANTU_TOOL_MODE` picks the presentation; anything the setting table rejects never gets this far. */
export function toolMode(env: NodeJS.ProcessEnv = process.env): ToolMode {
  return parseSetting(env, 'YUANTU_TOOL_MODE') === 'ptc' ? 'ptc' : 'native';
}

/** How many calls a failure trace names before it says how many more there were. */
const MAX_TRACE_ENTRIES = 40;
/** Arguments are shown in the trace; a program can pass something enormous to a tool, so each entry is capped. */
const MAX_TRACE_TEXT = 160;

/**
 * Where the program worker lives, in whichever form this build has it.
 *
 * Exported because the workflow tool runs its script in the same worker: the answer to "how is a model-written
 * program isolated and stopped" is one answer, and two copies of this would be two chances for one of them to
 * point at a file that is not there.
 */
export function codeWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith('.ts') ? './code-worker.ts' : './code-worker.js',
    import.meta.url,
  );
}

/**
 * The concurrency an inner call gets, by the same classification the model's own batches use.
 *
 * A program is not a second dispatcher. `Promise.all([tools.read_file(a), tools.edit_file(b)])` used to start both
 * at once — the worker's message handler did not wait for anything — so the one path that could have two approvals
 * pending at the same time, or two effect-journal entries interleaved, was the one inside a program. The registry
 * already answers "may this call overlap a sibling" (`executionMode`, fail-closed: a permission-bearing tool may
 * not, and neither may one that declares no classifier); this is that answer applied where the calls actually
 * start.
 *
 * A fair FIFO pool with variable-sized claims: a parallel call takes one slot, an *exclusive* call takes the whole
 * pool and therefore waits for its siblings to drain, and a later parallel call waits behind it rather than
 * squeezing past. Head-of-line blocking is the point here rather than a cost — it is what makes "exclusive" mean
 * alone rather than merely first.
 */
class GuestSlots {
  private readonly size: number;
  private free: number;
  private readonly waiting: { need: number; grant: () => void }[] = [];
  constructor(size: number) {
    this.size = Math.max(1, size);
    this.free = this.size;
  }
  async acquire(need: number): Promise<void> {
    const wanted = Math.min(Math.max(1, need), this.size);
    // Fast path only when nobody is waiting: a call that jumps the queue would be an exclusive one running beside
    // a sibling that arrived first.
    if (!this.waiting.length && this.free >= wanted) {
      this.free -= wanted;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push({ need: wanted, grant: resolve });
      this.pump();
    });
  }
  release(need: number): void {
    this.free += Math.min(Math.max(1, need), this.size);
    this.pump();
  }
  private pump(): void {
    while (this.waiting.length) {
      const next = this.waiting[0]!;
      if (this.free < next.need) return;
      this.waiting.shift();
      this.free -= next.need;
      next.grant();
    }
  }
}
export function runCodeTool(): Tool {
  return {
    name: RUN_CODE,
    cancellationGraceMs: 35000,
    description: BASE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          minLength: 1,
          maxLength: 200_000,
          description:
            'The body of an async function. `return` the answer; `await tools.<name>({...})` to call a tool.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const catalog = context.catalog;
      if (!catalog)
        throw new Error(
          'This run does not expose a tool catalog to programs; call the tools directly instead.',
        );
      // A program cannot start another program: the second one would add a worker, a second termination path and
      // no capability the first did not already have.
      const names = catalog.specs.map((spec) => spec.name).filter((name) => name !== RUN_CODE);
      if (!names.length) throw new Error('This run has no tools for a program to call.');
      const started = performance.now();
      const trace: string[] = [];
      const code = String(args.code);
      const worker = await startCodeProcess({ code, names } satisfies CodeWorkerData, context);
      const call = new AbortController();
      const innerSignal = AbortSignal.any([context.signal, call.signal]);
      /** The pool every inner call takes a slot from: see `GuestSlots` for why the width depends on the call. */
      const admission = new GuestSlots(catalog.parallelLimit);
      return await new Promise<ToolResult>((resolve, reject) => {
        let settled = false;
        const inFlight = new Map<Promise<void>, ToolCall>();
        /** Ends the call exactly once: the worker is stopped, the listener removed, then the promise settles. */
        const finish = (error?: unknown, result?: ToolResult) => {
          if (settled) return;
          settled = true;
          if (error instanceof Error && error.name === 'ProgramDisconnectedError') {
            error.message +=
              '\n[Known calls before disconnect]\n' + trace.slice(0, MAX_TRACE_ENTRIES).join('\n');
            if (inFlight.size) error.name = 'ToolCleanupError';
          }
          if (result && inFlight.size)
            result.content +=
              '\n[Program ended with pending tool calls. Known outcomes remain in the journal; inspect before repeating effects.]';
          context.signal.removeEventListener('abort', abort);
          call.abort(error ?? new Error('The program call is over'));
          void (async () => {
            let teardownError: unknown;
            try {
              await worker.terminate();
            } catch (cause) {
              teardownError = cause;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              Promise.allSettled([...inFlight.keys()]),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 30000);
                timer.unref?.();
              }),
            ]);
            clearTimeout(timer);
            for (const inner of inFlight.values()) context.programJournal?.record(inner, 'unknown');
            if (inFlight.size && !teardownError) {
              teardownError = new Error(
                'Program tool outcomes are unknown; inspect the journal before retrying effects',
              );
              (teardownError as Error).name = 'ToolCleanupError';
            }
            if (teardownError) reject(teardownError);
            else if (error) reject(error);
            else resolve(result!);
          })().catch(reject);
        };
        // The run's deadline and its cancellation both arrive here: this is the signal the registry gave *this*
        // call, so a program that loops forever is stopped by the same budget as any other call.
        const abort = () => finish(context.signal.reason ?? new Error('run_code was cancelled'));
        context.signal.addEventListener('abort', abort, { once: true });
        /** Answers one call. A reply that arrives after the call ended has nothing left to answer. */
        const reply = (id: number, outcome: { ok: boolean; content: string }) => {
          if (settled) return;
          worker.postMessage({ type: 'call-result', id, ...outcome });
        };
        /**
         * One inner call, answered to the program that made it.
         *
         * The id is prefixed with the outer call's so an approval, an audit record or a log line can always be
         * traced back to the program that wanted it.
         */
        const handleCall = async (message: CallRequest): Promise<void> => {
          if (!names.includes(message.name)) {
            finish(new Error('Program RPC tool is outside this run catalog'));
            return;
          }
          const arguments_ = (message.args ?? {}) as Record<string, unknown>;
          const inner: ToolCall = {
            id: `${context.callId ?? RUN_CODE}#${message.id}`,
            name: message.name,
            arguments: arguments_,
          };
          /**
           * The slot this call's own classification asks for, taken *before* the call starts.
           *
           * The classification is the registry's (`catalog.mode`), the width is the run's
           * (`catalog.parallelLimit`), and a call that has to wait is not started at all until its slot is free —
           * so a program that fires twenty writes at once gets them one at a time, which is what the model's own
           * batch would do with the same twenty calls.
           */
          const exclusive = catalog.mode(inner) === 'exclusive';
          const slots = exclusive ? catalog.parallelLimit : 1;
          await admission.acquire(slots);
          // The call may have been abandoned while it waited: the program's deadline, a Stop, or the worker's own
          // answer can all end the call, and a queued tool must not then run an effect nobody is waiting for.
          if (settled) {
            admission.release(slots);
            return;
          }
          const callStarted = performance.now();
          try {
            const result = await catalog.invoke(inner, innerSignal);
            context.programJournal?.record(inner, 'known', result);
            const imageNote = result.images?.length
              ? `\n[${result.images.length} picture(s) from ${message.name} are not visible inside a program; call ${message.name} directly to see them]`
              : '';
            trace.push(
              `  ${message.name}(${summariseArguments(arguments_)}) -> ${
                result.isError ? `failed: ${summarise(result.content)}` : summarise(result.content)
              } (${Math.round(performance.now() - callStarted)}ms)`,
            );
            reply(message.id, { ok: !result.isError, content: result.content + imageNote });
          } catch (error) {
            context.programJournal?.record(inner, 'unknown');
            if (runLevelFailure(error, context.signal)) {
              // Deferral, a cleanup failure and cancellation are the *run* speaking. Turning them into a
              // program-level throw would let the model catch a paused approval and carry on as if the call had
              // merely failed, which is the one thing an unattended run must not do.
              finish(error);
              return;
            }
            trace.push(
              `  ${message.name}(${summariseArguments(arguments_)}) -> threw: ${summarise(errorText(error))}`,
            );
            reply(message.id, { ok: false, content: errorText(error) });
          } finally {
            admission.release(slots);
          }
        };
        worker.once('error', (error) => finish(error));
        worker.on('message', (message: WorkerMessage | CallRequest) => {
          if (message.type === 'call') {
            if (settled) return;
            const running = handleCall(message);
            inFlight.set(running, {
              id: `${context.callId ?? RUN_CODE}#${message.id}`,
              name: message.name,
              arguments: message.args as Record<string, unknown>,
            });
            void running.finally(() => inFlight.delete(running)).catch((error) => finish(error));
            return;
          }
          finish(undefined, programResult(message, trace, performance.now() - started, names));
        });
        if (context.signal.aborted) abort();
      });
    },
  };
}

/** Deferral, cleanup failure and cancellation end the whole call — see the comment where this is used. */
export function runLevelFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = error instanceof Error ? error.name : '';
  return (
    error instanceof DeferredApprovalError ||
    name === 'DeferredApprovalError' ||
    name === 'ToolCleanupError' ||
    name === 'AbortError'
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function summarise(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TRACE_TEXT ? flat.slice(0, MAX_TRACE_TEXT) + '…' : flat;
}

/** Arguments as the trace shows them. A program can pass a cyclic or unserialisable value, so this cannot throw. */
function summariseArguments(args: Record<string, unknown>): string {
  try {
    return summarise(JSON.stringify(args) ?? String(args));
  } catch {
    return '[unserialisable arguments]';
  }
}

/**
 * The program's answer, what it printed, and what it did.
 *
 * The trace is a summary on success and the full list on failure: a program that worked does not need to be told
 * which calls it made (the model wrote them), but one that threw does — that trace is the difference between
 * "the program failed" and "it failed on the third call, and here is what that call returned".
 */
function programResult(
  message: WorkerMessage,
  trace: string[],
  elapsedMs: number,
  names: readonly string[],
): ToolResult {
  const parts: string[] = [];
  if (message.type === 'error') parts.push(`run_code failed: ${message.message}`, '');
  else parts.push(message.value.trim() ? message.value : '(the program returned no value)');
  if (message.logs.length) parts.push('', '[console]', ...message.logs);
  if (
    message.type === 'error' &&
    /require is not defined|dynamic import callback was not specified/i.test(message.message)
  ) {
    const example = names.includes('read_file')
      ? ' For files, use await tools.read_file({ path: "..." }).'
      : '';
    parts.push(
      'Module loading is unavailable in run_code; use the injected tools API.' +
        example +
        ' Do not retry require() or import().',
    );
  }
  if (message.type === 'error' && /console\.\w+ is not a function/.test(message.message)) {
    parts.push(
      'The program console supports console.log, console.info, console.warn, console.error and console.debug. Use console.log(value), or return an array/object as the program result.',
    );
  }
  const ms = Math.round(elapsedMs);
  if (message.type === 'error') {
    const shown = trace.slice(0, MAX_TRACE_ENTRIES);
    const more = trace.length - shown.length;
    parts.push(
      '',
      `[tools] ${trace.length} call(s) before the failure:`,
      ...shown,
      ...(more > 0 ? [`  …and ${more} more`] : []),
    );
  } else if (trace.length) {
    const names = trace.map((entry) => entry.trim().split(/[( ]/, 1)[0]!);
    parts.push('', `[tools] ${trace.length} call(s) in ${ms}ms: ${names.join(', ')}`);
  }
  return { isError: message.type === 'error', content: parts.join('\n') };
}
