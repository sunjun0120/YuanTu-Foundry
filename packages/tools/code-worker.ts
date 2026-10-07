/**
 * The program side of `run_code` and `workflow`: it runs the model's code and turns every call home into a
 * message.
 *
 * This file is a worker thread's entry point, so it has no imports beyond the two Node modules it needs and no
 * shared state with the host. The program it runs is code a *model* wrote, which sets the design:
 *
 * - **The program's whole capability surface is what the host injects.** Nothing else is available, and the
 *   sandbox context is created without Node's globals, so there is no `process`, `require`, `fetch` or `Buffer`
 *   to reach for directly. String code generation is disabled, but injected functions can still expose another
 *   realm: VM is not a security boundary. This worker lives in an independent, backend-launched Node process.
 *   The Host treats every message as untrusted and checks its catalog and arguments before any tool runs.
 * - **Two surfaces, one runner.** `kind: 'tools'` injects the tool catalog (`await tools.<name>({…})` is one real
 *   tool call); `kind: 'workflow'` injects the orchestration hooks (`agent()`, `phase()`, `log()`, `args`, and the
 *   two combinators). Both are the same worker with the same termination path, because "how a model-written
 *   program is isolated and stopped" is one question and should not have two answers that can drift apart.
 * - **A failed call throws inside the program.** That is what makes `try`/`catch` the way a program handles an
 *   expected failure, instead of matching on a string it was handed. The combinators are the exception that proves
 *   it: `parallel` and `pipeline` turn a throw into `null` for that item, because their whole purpose is to run
 *   many things that may fail.
 * - **Serialisation happens here, not in the host.** A program may return a value that cannot cross a
 *   `postMessage` boundary (a function, a cycle, a live object), so the value is turned into text while it is
 *   still in the context that produced it. Console output is collected the same way and returned alongside.
 */
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

/** What the host sends back for one call the program made. */
interface CallReply {
  type: 'call-result';
  id: number;
  ok: boolean;
  content: string;
}
/** What the program's result is sent to the host as. */
interface ProgramResult {
  type: 'result';
  value: string;
  logs: string[];
}
interface ProgramFailure {
  type: 'error';
  message: string;
  logs: string[];
}
export type WorkerMessage = ProgramResult | ProgramFailure;
/** What the program sends the host when it calls a tool or a workflow hook. */
export interface CallRequest {
  type: 'call';
  id: number;
  name: string;
  args: unknown;
}
export interface CodeWorkerData {
  code: string;
  /**
   * Which capability surface to inject. Defaults to `tools`, which is what `run_code` has always asked for, so
   * the worker's existing callers do not have to know this field exists.
   */
  kind?: 'tools' | 'workflow';
  /** For `tools`: the callable tool names. For `workflow`: the hook names the host is willing to serve. */
  names: readonly string[];
  /** For `workflow`: the value the caller passed as `args`, frozen and handed to the script as data. */
  args?: unknown;
  /**
   * For `workflow`: this host's ceilings, so the *script* is told immediately when it breaks one.
   *
   * The host enforces all of these too and stays the authority on them. They travel here because a check that only
   * happens after a round trip can be swallowed by a script that forgot to `await` a hook; a synchronous throw at
   * the call site cannot — it lands in the caller's stack, where `try`/`catch` or the end of the script will see it.
   */
  limits?: {
    maxAgents: number;
    maxPromptChars: number;
    maxNameChars: number;
    maxPhases: number;
  };
}

/** Console output is written to the program's result, so it has to be bounded before it gets there. */
const MAX_LOG_CHARS = 8_000;
const MAX_LOG_ENTRIES = 200;
/** The program's return value becomes tool output; the result stage truncates, but not before we copy it. */
const MAX_VALUE_CHARS = 400_000;

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function render(...values: unknown[]): string {
  return values.map(describe).join(' ');
}

const { code, names, kind = 'tools', args, limits } = workerData as CodeWorkerData;
const port = parentPort!;
const pending = new Map<
  number,
  { resolve: (value: string) => void; reject: (error: Error) => void }
>();
let nextId = 1;

port.on('message', (message: CallReply) => {
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.ok) waiting.resolve(message.content);
  else waiting.reject(new Error(message.content));
});

/**
 * One call home, awaited.
 *
 * The id is per program rather than the tool name, because the same tool may be called many times and the host
 * answers in whatever order the calls finish — matching on the name would pair a reply with the wrong call.
 */
function callTool(name: string, args: unknown): Promise<string> {
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'call', id, name, args } satisfies CallRequest);
  });
}

const logs: string[] = [];
const log = (...values: unknown[]) => {
  if (logs.length < MAX_LOG_ENTRIES) logs.push(render(...values));
};
/** The tool surface: one function per tool name, each call a real, host-checked tool call. */
function toolSurface(): Record<string, unknown> {
  const tools: Record<string, (args?: unknown) => Promise<string>> = {};
  for (const name of names) tools[name] = (value) => callTool(name, value ?? {});
  return { tools: Object.freeze(tools), console: consoleSurface() };
}
/**
 * The orchestration surface: run sub-agents and label the work.
 *
 * `agent()` resolves to what the child said. A child that failed rejects, so `try`/`catch` (or a combinator)
 * is how a script deals with it — the same rule the tool surface follows, and the reason `parallel`/`pipeline`
 * exist rather than the script having to write the catching itself every time.
 *
 * `phase()` is bookkeeping, not progress reporting: the host records which phase each call happened in and
 * reports that in the result. It deliberately does not emit an event of its own — the children a workflow
 * starts already announce themselves live (`subagent.started`/`subagent.finished`), and a second progress
 * channel with its own vocabulary would be one more thing to keep in step.
 */
function workflowSurface(): Record<string, unknown> {
  const ceilings = limits ?? {
    maxAgents: 24,
    maxPromptChars: 8_000,
    maxNameChars: 80,
    maxPhases: 32,
  };
  let started = 0;
  let phases = 0;
  const agent = async (prompt: unknown, options: unknown): Promise<unknown> => {
    /**
     * The shape checks are synchronous, and that is the point.
     *
     * `await agent(42)` and `agent(42)` must fail the same way. If the refusal came back as a rejected promise,
     * a script that forgot the `await` would continue as if nothing had happened — which is the failure mode a
     * model-written script actually hits. The host re-checks every one of these; here they exist so the throw is
     * in the caller's stack.
     */
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new Error('agent() needs a non-empty prompt string.');
    if (prompt.length > ceilings.maxPromptChars)
      throw new Error(`agent() prompt is longer than ${ceilings.maxPromptChars} characters.`);
    const chosen = options === undefined || options === null ? {} : options;
    if (typeof chosen !== 'object' || Array.isArray(chosen))
      throw new Error(
        'agent() options must be an object, for example { model: "…", schema: { … } }.',
      );
    const settings = chosen as Record<string, unknown>;
    const unsupported = Object.keys(settings).filter((key) => key !== 'model' && key !== 'schema');
    if (unsupported.length)
      throw new Error(
        `agent() does not accept ${unsupported.join(', ')} on this host; it supports: model, schema.`,
      );
    const schema = settings.schema;
    if (schema !== undefined) {
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
        throw new Error('agent() schema must be a JSON Schema object describing the answer.');
      if ((schema as { type?: unknown }).type !== 'object')
        throw new Error('agent() schema must describe an object (`"type": "object"`).');
    }
    if (started >= ceilings.maxAgents)
      throw new Error(
        `This workflow has already started ${started} sub-agents, which is its limit; no further agent() call is accepted.`,
      );
    started++;
    // The options travel as one object so the host validates a single shape rather than a list of positional
    // fields — a workflow written against a newer host must fail loudly there, not silently ignore a field.
    const reply = await callTool('agent', { prompt, options: settings });
    // A schema was asked for, so the answer *is* that object: the host replies with it as JSON, and parsing it
    // here is what makes `agent(prompt, {schema})` resolve to an object instead of to a string of JSON.
    return schema === undefined ? reply : JSON.parse(reply);
  };
  /**
   * Labels the calls that follow.
   *
   * Fire-and-forget on purpose: `phase('x')` reads like a statement, and a script that does not `await` it must
   * not turn a bookkeeping call into an unhandled rejection. What can be checked without the host — the shape —
   * throws synchronously; what only the host knows (how many phases a workflow may declare) is enforced there and
   * reported in the result.
   */
  const phase = (title: unknown): void => {
    if (typeof title !== 'string' || !title.trim())
      throw new Error('phase() needs a non-empty title string.');
    if (title.length > ceilings.maxNameChars)
      throw new Error(`phase() title is longer than ${ceilings.maxNameChars} characters.`);
    if (phases >= ceilings.maxPhases)
      throw new Error(`A workflow may declare at most ${ceilings.maxPhases} phases.`);
    phases++;
    void callTool('phase', { title }).catch(() => {});
  };
  /**
   * Runs zero-argument functions concurrently and resolves all of them.
   *
   * A throwing thunk resolves to `null` instead of rejecting the whole call: the pattern this exists for is
   * "fan out, then use whatever came back", and making the caller write `.catch(() => null)` for every item is
   * how a script ends up with a silent `undefined` instead.
   */
  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) throw new Error('parallel() takes an array of functions');
    return Promise.all(
      thunks.map(async (thunk, index) => {
        if (typeof thunk !== 'function')
          throw new Error(`parallel(): item ${index} is not a function`);
        try {
          return await (thunk as () => unknown)();
        } catch {
          return null;
        }
      }),
    );
  };
  /**
   * Runs each item through the stages independently, with no barrier between stages.
   *
   * A stage that throws drops *that item* to `null` and skips its remaining stages; the other items carry on.
   * Each item's own stages still run in order, which is what makes a pipeline a pipeline rather than a fan-out
   * of stages.
   */
  const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new Error('pipeline() takes an array of items');
    if (!stages.length) throw new Error('pipeline() needs at least one stage');
    for (const [index, stage] of stages.entries())
      if (typeof stage !== 'function')
        throw new Error(`pipeline(): stage ${index} is not a function`);
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages as ((
          previous: unknown,
          item: unknown,
          index: number,
        ) => unknown)[]) {
          try {
            value = await stage(value, item, index);
          } catch {
            return null;
          }
        }
        return value;
      }),
    );
  };
  return {
    agent,
    phase,
    parallel,
    pipeline,
    log,
    args: Object.freeze(structuredClone(args ?? null)),
    console: consoleSurface(),
  };
}
/** `console.log` and friends all land in the same bounded log, like they do for a tool program. */
function consoleSurface(): Record<string, unknown> {
  return { log, info: log, warn: log, error: log, debug: log };
}

const context = vm.createContext(kind === 'workflow' ? workflowSurface() : toolSurface(), {
  codeGeneration: { strings: false, wasm: false },
});

/**
 * The program is the body of an async function, so `return` is the answer and `await` works at the top level.
 *
 * Wrapping rather than evaluating the text as a script is the whole reason a program can return a value at all:
 * a script's completion value is not available through `vm`, and asking the model to assign to a magic global
 * would be a convention it could forget.
 */
void (async () => {
  try {
    const answer: unknown = await vm.runInContext(`(async () => {\n${code}\n})()`, context, {
      filename: 'run_code.js',
    });
    // Cloned inside the context that produced it: an object the program still holds can be cyclic, and the
    // structured clone a `postMessage` would do would throw on it after the program had already succeeded.
    const text = describe(answer);
    port.postMessage({
      type: 'result',
      value:
        text.length > MAX_VALUE_CHARS
          ? text.slice(0, MAX_VALUE_CHARS) + '\n[program result truncated]'
          : text,
      logs: boundedLogs(),
    } satisfies ProgramResult);
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      logs: boundedLogs(),
    } satisfies ProgramFailure);
  }
})();

function boundedLogs(): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const entry of logs) {
    if (chars + entry.length > MAX_LOG_CHARS - '[console output truncated]'.length) {
      kept.push('[console output truncated]');
      break;
    }
    chars += entry.length;
    kept.push(entry);
  }
  return kept;
}
