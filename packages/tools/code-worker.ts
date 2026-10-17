/**
 * The program side of `run_code` and `workflow`: it runs the model's code and turns every call home into a
 * message.
 *
 * This file is a worker thread's entry point, so it has no imports beyond the two Node modules it needs and no
 * shared state with the host. The program it runs is code a *model* wrote, which sets the design:
 *
 * - **No object of this realm is ever reachable from the program.** A function handed into a `vm` context keeps
 *   its own realm, so `tools.read_file.constructor('return process')()` on an injected function used to be the
 *   worker's `Function`, outside every restriction of the context. The context is therefore created without a
 *   contextified sandbox object (`DONT_CONTEXTIFY`), and its whole surface — `tools.*`, `console`, the workflow
 *   hooks, their Promises and Errors — is built *inside* it by `guestRuntime`. Only primitives cross: strings
 *   (JSON for arguments), numbers and booleans. The bridge functions that `guestRuntime` closes over are
 *   strict-mode, null-prototype and never throw, so even a leaked reference has no `constructor` to climb, and
 *   no outer exception lands in program code.
 * - **Defence in depth below that.** Network globals are removed from this realm before any program runs, and
 *   the runner process is started under Node's permission model (see `code-process.ts`). Neither is the
 *   boundary; the realm separation is.
 * - **Two surfaces, one runner.** `kind: 'tools'` installs the tool catalog (`await tools.<name>({…})` is one real
 *   tool call); `kind: 'workflow'` installs the orchestration hooks (`agent()`, `phase()`, `log()`, `args`, and
 *   the two combinators). Both are the same worker with the same termination path, because "how a model-written
 *   program is isolated and stopped" is one question and should not have two answers that can drift apart.
 * - **A failed call throws inside the program.** That is what makes `try`/`catch` the way a program handles an
 *   expected failure, instead of matching on a string it was handed. The combinators are the exception that proves
 *   it: `parallel` and `pipeline` turn a throw into `null` for that item, because their whole purpose is to run
 *   many things that may fail.
 * - **Serialisation happens in the program's realm, not here.** A program may return a value that cannot cross a
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
  /**
   * Tests only: hand the program this worker's real `process` as the global `escapedProcess`.
   *
   * The VM is the first boundary and the restricted runner process is the second. A program can no longer reach
   * the second on its own, so the tests that prove the second still holds (no fs write grant, a forged RPC is
   * refused, a flood is cut off, a disconnect is survived) need what an escape *would* have given them. Only host
   * code that builds this object can set it — the model controls `code` and nothing else — and no product caller
   * does.
   */
  exposeProcessForTests?: boolean;
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

/**
 * Network globals this realm would otherwise carry. The program cannot reach this realm, so this is the second
 * wall rather than the first: if it ever can, it still finds no `fetch` to send the workspace anywhere with.
 */
const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource'] as const;
for (const name of NETWORK_GLOBALS) delete (globalThis as Record<string, unknown>)[name];

/** The primitive-only calls `guestRuntime` makes home. Each returns a primitive and never throws. */
interface Bridge {
  /** Sends one call; returns its id, or 0 when it could not be sent. */
  call(name: unknown, argsJson: unknown): number;
  log(text: unknown): void;
  finish(ok: unknown, text: unknown): void;
}
/** What `guestRuntime` hands back: functions of the program's realm, called here with primitives only. */
interface GuestApi {
  deliver(id: number, ok: boolean, content: string): void;
  start(program: unknown): void;
}

/**
 * Everything the program can see, built in the program's own realm.
 *
 * This function is never called here: its *source* is compiled inside the context, so every object, function,
 * Promise and Error it makes belongs to that realm. It must stay self-contained (no reference to anything outside
 * its own body) and it captures the intrinsics it relies on before any program code runs, so a program that
 * replaces `JSON` or `Promise` changes its own behaviour, not the bridge's.
 */
function guestRuntime(configJson: string, bridge: Bridge): GuestApi {
  'use strict';
  const freeze = Object.freeze;
  const create = Object.create;
  const keys = Object.keys;
  const isArray = Array.isArray;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const PromiseCtor = Promise;
  const ErrorCtor = Error;
  const StringCtor = String;
  const config = parse(configJson) as {
    kind: 'tools' | 'workflow';
    names: string[];
    args: unknown;
    limits: { maxAgents: number; maxPromptChars: number; maxNameChars: number; maxPhases: number };
  };
  const pending: Record<
    number,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  > = create(null);

  function describe(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      const json = stringify(value);
      return json === undefined ? StringCtor(value) : json;
    } catch {
      try {
        return StringCtor(value);
      } catch {
        return '[unprintable value]';
      }
    }
  }
  function messageOf(error: unknown): string {
    try {
      return error instanceof ErrorCtor ? StringCtor(error.message) : StringCtor(error);
    } catch {
      return '[unprintable error]';
    }
  }
  function log(...values: unknown[]): void {
    let text = '';
    for (let index = 0; index < values.length; index++)
      text += (index ? ' ' : '') + describe(values[index]);
    try {
      bridge.log(text);
    } catch {
      // A bridge call can only fail on stack exhaustion; the line is dropped rather than an outer error surfacing.
    }
  }
  function finish(ok: boolean, text: string): void {
    try {
      bridge.finish(ok, text);
    } catch {
      // As above: nothing from the other realm may reach the program.
    }
  }
  /**
   * One call home, awaited.
   *
   * The id is per program rather than the tool name, because the same tool may be called many times and the host
   * answers in whatever order the calls finish — matching on the name would pair a reply with the wrong call.
   */
  function callTool(name: string, value: unknown): Promise<string> {
    let text: string | undefined;
    try {
      text = stringify(value);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string')
      throw new ErrorCtor(`${name}() arguments must be JSON-serialisable.`);
    let id = 0;
    try {
      id = bridge.call(name, text);
    } catch {
      id = 0;
    }
    if (typeof id !== 'number' || id < 1)
      throw new ErrorCtor(`${name}() could not be sent to the host.`);
    return new PromiseCtor<string>((resolve, reject) => {
      const entry = create(null) as {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      };
      entry.resolve = resolve;
      entry.reject = reject;
      pending[id] = entry;
    });
  }
  /** `console.log` and friends all land in the same bounded log, like they do for a tool program. */
  const console = freeze({ log, info: log, warn: log, error: log, debug: log });
  const surface: Record<string, unknown> = { console };

  if (config.kind === 'workflow') {
    const ceilings = config.limits;
    let started = 0;
    let phases = 0;
    /**
     * Runs a sub-agent and resolves to what the child said.
     *
     * A child that failed rejects, so `try`/`catch` (or a combinator) is how a script deals with it — the same rule
     * the tool surface follows. The shape checks run before anything is sent, so a malformed call never reaches the
     * host; the host re-checks every one of them all the same.
     */
    const agent = async (prompt: unknown, options: unknown): Promise<unknown> => {
      if (typeof prompt !== 'string' || !prompt.trim())
        throw new ErrorCtor('agent() needs a non-empty prompt string.');
      if (prompt.length > ceilings.maxPromptChars)
        throw new ErrorCtor(`agent() prompt is longer than ${ceilings.maxPromptChars} characters.`);
      const chosen = options === undefined || options === null ? {} : options;
      if (typeof chosen !== 'object' || isArray(chosen))
        throw new ErrorCtor(
          'agent() options must be an object, for example { model: "…", schema: { … } }.',
        );
      const settings = chosen as Record<string, unknown>;
      const unsupported = keys(settings).filter((key) => key !== 'model' && key !== 'schema');
      if (unsupported.length)
        throw new ErrorCtor(
          `agent() does not accept ${unsupported.join(', ')} on this host; it supports: model, schema.`,
        );
      const schema = settings.schema;
      if (schema !== undefined) {
        if (typeof schema !== 'object' || schema === null || isArray(schema))
          throw new ErrorCtor('agent() schema must be a JSON Schema object describing the answer.');
        if ((schema as { type?: unknown }).type !== 'object')
          throw new ErrorCtor('agent() schema must describe an object (`"type": "object"`).');
      }
      if (started >= ceilings.maxAgents)
        throw new ErrorCtor(
          `This workflow has already started ${started} sub-agents, which is its limit; no further agent() call is accepted.`,
        );
      started++;
      // The options travel as one object so the host validates a single shape rather than a list of positional
      // fields — a workflow written against a newer host must fail loudly there, not silently ignore a field.
      const reply = await callTool('agent', { prompt, options: settings });
      // A schema was asked for, so the answer *is* that object: the host replies with it as JSON, and parsing it
      // here is what makes `agent(prompt, {schema})` resolve to an object instead of to a string of JSON.
      return schema === undefined ? reply : parse(reply);
    };
    /**
     * Labels the calls that follow.
     *
     * Fire-and-forget on purpose: `phase('x')` reads like a statement, and a script that does not `await` it must
     * not turn a bookkeeping call into an unhandled rejection. What can be checked without the host — the shape —
     * throws synchronously; what only the host knows is enforced there and reported in the result.
     */
    const phase = (title: unknown): void => {
      if (typeof title !== 'string' || !title.trim())
        throw new ErrorCtor('phase() needs a non-empty title string.');
      if (title.length > ceilings.maxNameChars)
        throw new ErrorCtor(`phase() title is longer than ${ceilings.maxNameChars} characters.`);
      if (phases >= ceilings.maxPhases)
        throw new ErrorCtor(`A workflow may declare at most ${ceilings.maxPhases} phases.`);
      phases++;
      callTool('phase', { title }).then(undefined, () => {});
    };
    /**
     * Runs zero-argument functions concurrently and resolves all of them.
     *
     * A throwing thunk resolves to `null` instead of rejecting the whole call: the pattern this exists for is
     * "fan out, then use whatever came back".
     */
    const parallel = async (thunks: unknown): Promise<unknown[]> => {
      if (!isArray(thunks)) throw new ErrorCtor('parallel() takes an array of functions');
      return PromiseCtor.all(
        thunks.map(async (thunk: unknown, index: number) => {
          if (typeof thunk !== 'function')
            throw new ErrorCtor(`parallel(): item ${index} is not a function`);
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
     */
    const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
      if (!isArray(items)) throw new ErrorCtor('pipeline() takes an array of items');
      if (!stages.length) throw new ErrorCtor('pipeline() needs at least one stage');
      for (let index = 0; index < stages.length; index++)
        if (typeof stages[index] !== 'function')
          throw new ErrorCtor(`pipeline(): stage ${index} is not a function`);
      return PromiseCtor.all(
        items.map(async (item: unknown, index: number) => {
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
    surface.agent = agent;
    surface.phase = phase;
    surface.parallel = parallel;
    surface.pipeline = pipeline;
    surface.log = log;
    surface.args = freeze(config.args ?? null);
  } else {
    /** The tool surface: one function per tool name, each call a real, host-checked tool call. */
    const tools: Record<string, (value?: unknown) => Promise<string>> = {};
    for (const name of config.names) tools[name] = (value) => callTool(name, value ?? {});
    surface.tools = freeze(tools);
  }
  for (const name of keys(surface)) (globalThis as Record<string, unknown>)[name] = surface[name];

  const api = create(null) as GuestApi;
  api.deliver = (id, ok, content) => {
    const entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (ok) entry.resolve(content);
    else entry.reject(new ErrorCtor(content));
  };
  api.start = (program) => {
    if (typeof program !== 'function') {
      finish(false, 'The program did not compile to a function body.');
      return;
    }
    void (async () => {
      let answer: unknown;
      try {
        answer = await (program as () => unknown)();
      } catch (error) {
        finish(false, messageOf(error));
        return;
      }
      finish(true, describe(answer));
    })();
  };
  return freeze(api);
}

const {
  code,
  names,
  kind = 'tools',
  args,
  limits,
  exposeProcessForTests,
} = workerData as CodeWorkerData;
const port = parentPort!;
const logs: string[] = [];
let nextId = 1;
let finished = false;

/** Makes an outer function safe to hold from the program's realm: no prototype chain, no mutable surface. */
function sealed<T extends (...values: never[]) => unknown>(fn: T): T {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

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

function report(ok: boolean, text: string): void {
  if (finished) return;
  finished = true;
  port.postMessage(
    ok
      ? ({
          type: 'result',
          value:
            text.length > MAX_VALUE_CHARS
              ? text.slice(0, MAX_VALUE_CHARS) + '\n[program result truncated]'
              : text,
          logs: boundedLogs(),
        } satisfies ProgramResult)
      : ({ type: 'error', message: text, logs: boundedLogs() } satisfies ProgramFailure),
  );
}

const bridge: Bridge = Object.freeze(
  Object.setPrototypeOf(
    {
      call: sealed((name: unknown, argsJson: unknown): number => {
        try {
          if (finished || typeof name !== 'string' || typeof argsJson !== 'string') return 0;
          if (!names.includes(name)) return 0;
          const id = nextId++;
          port.postMessage({
            type: 'call',
            id,
            name,
            args: JSON.parse(argsJson) as unknown,
          } satisfies CallRequest);
          return id;
        } catch {
          return 0;
        }
      }),
      log: sealed((text: unknown): void => {
        try {
          if (typeof text === 'string' && logs.length < MAX_LOG_ENTRIES) logs.push(text);
        } catch {
          // Never let an outer error reach the program.
        }
      }),
      finish: sealed((ok: unknown, text: unknown): void => {
        try {
          report(ok === true, typeof text === 'string' ? text : String(text));
        } catch {
          // As above.
        }
      }),
    },
    null,
  ) as Bridge,
);

/** The message of an error this realm threw (setup, compilation). Never called with a value of the program's. */
function outerMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The program could not be started.';
}

try {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    codeGeneration: { strings: false, wasm: false },
  });
  const install = new vm.Script(`(${guestRuntime.toString()})`, {
    filename: 'run_code-runtime.js',
  }).runInContext(context) as typeof guestRuntime;
  const config = JSON.stringify({
    kind,
    names,
    args: args ?? null,
    limits: limits ?? { maxAgents: 24, maxPromptChars: 8_000, maxNameChars: 80, maxPhases: 32 },
  });
  const api = install(config, bridge);
  if (exposeProcessForTests === true)
    Object.defineProperty(context, 'escapedProcess', { value: process, enumerable: false });
  // Read once, before any program code exists, so nothing the program does can change what is called below.
  const deliver = api.deliver;
  const start = api.start;
  port.on('message', (message: CallReply) => {
    try {
      deliver(Number(message.id), message.ok === true, String(message.content));
    } catch {
      // The program's realm threw; its own code will see the consequence, this side has nothing to add.
    }
  });
  /**
   * The program is the body of an async function, so `return` is the answer and `await` works at the top level.
   *
   * Wrapping rather than evaluating the text as a script is the whole reason a program can return a value at all:
   * a script's completion value is not available through `vm`, and asking the model to assign to a magic global
   * would be a convention it could forget.
   */
  let script: vm.Script | undefined;
  try {
    script = new vm.Script(`(async () => {\n${code}\n})`, { filename: 'run_code.js' });
  } catch (error) {
    // A compile error is this realm's own SyntaxError, so its message is safe to read.
    report(false, outerMessage(error));
  }
  if (script) {
    let program: unknown;
    try {
      program = script.runInContext(context);
    } catch {
      // Only text that broke out of the wrapper can throw here, and what it threw belongs to the program's realm:
      // it is not inspected from this side.
      report(false, 'The program threw before its body started.');
    }
    if (!finished) start(program);
  }
} catch (error) {
  report(false, outerMessage(error));
}
