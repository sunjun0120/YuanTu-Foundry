import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxConfig } from './sandbox-provider.ts';
import { ptyProvider, type PtyProcess } from './pty-provider.ts';
import { Workspace } from './files.ts';
import { localExecutionEnvironment } from './execution-environment.ts';
import {
  executionPolicy,
  snapshotExecutionPolicy,
  currentExecutionPolicy,
} from './execution-policy.ts';
import type { ExecutionPolicy } from '../protocol/execution.ts';
import { bounded, failure } from './registry.ts';
import type { Tool, ToolContext } from '../protocol/index.ts';

/**
 * Terminals: the one kind of work a command runner cannot express.
 *
 * `run_command` is "run this to completion and give me the bytes", and `start_command` is the same with the
 * output coming back in pages. Both are the wrong shape for a program that *converses*: an interactive rebase,
 * a REPL, a debugger, `ssh` asking for a passphrase, a test runner watching for a keypress. For those the
 * shell has to be attached to a terminal — it echoes, it wraps, it reads a line at a time — and that is what
 * this manager owns.
 *
 * The decisions worth naming, because each one is a way this could have been unsafe or useless:
 *
 * 1. **A terminal outlives the run that opened it.** It belongs to the *session scope*, exactly like the
 *    background-command manager, so a REPL started in one run is still there in the next one — which is the
 *    only reason to have a terminal rather than a command. It is closed by `terminal_close`, by the host at
 *    shutdown, or by the program itself exiting.
 * 2. **The session backend supplies the executable.** Host and Windows launch through the paired execution
 *    contract; container PTYs remain unsupported. The creation policy stays with the process, and a changed
 *    policy may observe or close it but cannot type into it or signal it as though it had been recreated.
 * 3. **Opening and typing ask for approval; reading does not.** `terminal_open` spawns a program on the host,
 *    `terminal_send` puts text into a shell that will execute it, and `terminal_signal` ends a process, so all
 *    three carry `permission: 'command'`. `terminal_read` and `terminal_list` are observations of this
 *    session's own state, so they carry none — which also means a read-only run can watch a terminal it was
 *    told about without being able to start or steer one.
 * 4. **The output is a ring, and reads are cursors.** A terminal that prints a build log forever must not grow
 *    this process, so the manager keeps the last 64 KB and every read answers with a `nextCursor` and whether
 *    it fell off the end. `wait_ms` turns a read into "tell me when there is something new", which is what
 *    makes a terminal usable without polling in a loop.
 * 5. **Nothing here is a job.** A terminal is not listed by `job_list` and not killed by `job_kill`: a job is
 *    work with an outcome the run waits for, a terminal is a place the run types. Mixing them would make
 *    `job_kill` able to close a REPL somebody is still using.
 */
/** Terminals one manager will keep, and how many may be live at once. Mirrors the background-command caps. */
const MAX_TERMINALS = 8;
const MAX_KEPT = 32;
/** Where the terminal is a terminal: a screen of scrollback, kept as text. */
const RING_CHARS = 65_536;
const READ_CHARS = 3000;
const MAX_INPUT_CHARS = 4000;
/** A named program takes an argv, and an argv has to stay small enough to read in an approval prompt. */
const MAX_ARGS = 16;
const MAX_ARG_CHARS = 500;
/** A read may wait this long for something to happen; the caller asks, and this is the ceiling. */
const MAX_WAIT_MS = 120_000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const;
type TerminalSignal = (typeof SIGNALS)[number];
export interface TerminalSnapshot {
  id: string;
  sessionId: string;
  label: string;
  cwd: string;
  createdAt: string;
  status: 'running' | 'exited';
  pid?: number;
  exitCode: number | null;
  output: string;
  nextCursor: number;
  truncated: boolean;
}
interface Terminal {
  id: string;
  scope: string;
  label: string;
  cwd: string;
  createdAt: string;
  process: PtyProcess;
  policy: ExecutionPolicy;
  closed: Promise<void>;
  stopping?: Promise<void>;
  status: 'running' | 'exited';
  exitCode: number | null;
  output: string;
  total: number;
  offset: number;
  /** Resolved whenever something a reader might want to see happened: new output, or an exit. */
  listeners: Set<() => void>;
}
/** The shell a terminal starts when the caller did not name a program. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): {
  file: string;
  args: string[];
} {
  if (process.platform === 'win32') return { file: env.ComSpec ?? 'cmd.exe', args: [] };
  return { file: env.SHELL ?? '/bin/sh', args: [] };
}
export class TerminalSessions {
  private terms = new Map<string, Terminal>();
  private opening = 0;
  private pending = new Map<Promise<TerminalSnapshot>, string>();
  private closedScopes = new Set<string>();
  private closing = false;
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  /** The tools bound to one session scope, exactly as the job tools are. */
  tools(scope: string): Tool[] {
    return [
      this.openTool(scope),
      this.listTool(scope),
      this.readTool(scope),
      this.sendTool(scope),
      this.signalTool(scope),
      this.closeTool(scope),
    ];
  }
  private get(id: string, scope: string): Terminal {
    const terminal = this.terms.get(id);
    if (!terminal || terminal.scope !== scope) throw new Error('Unknown terminal');
    return terminal;
  }
  private snapshot(terminal: Terminal, cursor = 0): TerminalSnapshot {
    if (cursor > terminal.total) throw new Error('Invalid output cursor');
    const start = Math.max(cursor, terminal.offset);
    const output = terminal.output.slice(
      start - terminal.offset,
      start - terminal.offset + READ_CHARS,
    );
    return {
      id: terminal.id,
      sessionId: terminal.scope,
      label: terminal.label,
      cwd: terminal.cwd,
      createdAt: terminal.createdAt,
      status: terminal.status,
      ...(terminal.process.pid === undefined ? {} : { pid: terminal.process.pid }),
      exitCode: terminal.exitCode,
      output,
      nextCursor: start + output.length,
      truncated: cursor < terminal.offset,
    };
  }
  list(scope?: string): TerminalSnapshot[] {
    return [...this.terms.values()]
      .filter((terminal) => scope === undefined || terminal.scope === scope)
      .map((terminal) => this.snapshot(terminal, terminal.total));
  }
  /**
   * Start a terminal.
   *
   * The order of the checks is the order of the promises being made: the sandbox first (nothing is spawned
   * before the run is allowed to have a terminal at all), then the backend's availability, then the caps.
   */
  open(
    args: Record<string, unknown>,
    context: ToolContext,
    scope: string,
  ): Promise<TerminalSnapshot> {
    const pending = this.openOnce(args, context, scope);
    this.pending.set(pending, scope);
    return pending.finally(() => this.pending.delete(pending));
  }
  private assertOpen(scope: string): void {
    if (this.closing || this.closedScopes.has(scope))
      throw new Error('Terminal scope is closing or closed');
  }
  private async openOnce(
    args: Record<string, unknown>,
    context: ToolContext,
    scope: string,
  ): Promise<TerminalSnapshot> {
    this.assertOpen(scope);
    const config = resolveSandboxConfig();
    const policy = snapshotExecutionPolicy(
      context.executionPolicy ?? currentExecutionPolicy() ?? executionPolicy(config.mode, config),
    );
    const mode = policy.mode;
    if (mode !== 'host' && mode !== 'windows')
      throw new Error(
        `Terminals run a shell on the host, which would be a way around the ${mode} sandbox this run's commands are confined to. Use run_command or start_command instead, or set YUANTU_SANDBOX=host to run unconfined.`,
      );
    const provider = ptyProvider();
    const unavailable = await provider.available();
    if (unavailable) throw new Error(unavailable);
    context.signal.throwIfAborted();
    this.assertOpen(scope);
    if (this.liveCount() + this.opening >= MAX_TERMINALS)
      throw new Error(`Terminal limit is ${MAX_TERMINALS}; close one with terminal_close first`);
    this.opening++;
    try {
      while (this.terms.size >= MAX_KEPT) {
        const oldest = [...this.terms.values()].find((terminal) => terminal.status === 'exited');
        if (!oldest) break;
        this.terms.delete(oldest.id);
      }
      const cwd = await new Workspace(this.root).resolve(String(args.cwd ?? '.'));
      let named =
        typeof args.command === 'string' && args.command.trim() ? String(args.command).trim() : '';
      /**
       * A program is a program, not a command line.
       *
       * `shell(file, args)` takes an argv, and inventing a splitter here would be the classic way to run something
       * other than what was asked for (`git commit -m "a b"` in one string has no correct split). A value with
       * whitespace is accepted only when it identifies an existing file (including an installation path with
       * spaces). It is still passed as one executable, never split or interpreted by a shell.
       */
      if (/\s/.test(named)) {
        const executable = path.resolve(cwd, named);
        const file = await stat(executable).catch(() => undefined);
        if (!file?.isFile())
          throw new Error(
            `\`command\` names one program, not a command line (got "${named}"). Pass the arguments in \`args\`, or open a shell and type the line with terminal_send.`,
          );
        named = executable;
      }
      const namedArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];
      if (namedArgs.length > MAX_ARGS) throw new Error(`\`args\` is limited to ${MAX_ARGS} items`);
      if (namedArgs.some((value) => value.length > MAX_ARG_CHARS))
        throw new Error(`Each \`args\` item is limited to ${MAX_ARG_CHARS} characters`);
      if (!named && namedArgs.length) throw new Error('`args` needs a `command` to pass them to');
      const shell = named ? { file: named, args: namedArgs } : defaultShell();
      const columns = clampDimension(args.columns, 80);
      const rows = clampDimension(args.rows, 24);
      const command = [shell.file, ...shell.args].join(' ');
      const environment = await localExecutionEnvironment(this.root, policy);
      const plan = await environment.processes.prepare(
        shell.file,
        path.relative(environment.identity.root, cwd) || '.',
        shell.args,
        context.signal,
      );
      let child: PtyProcess;
      try {
        child = await provider.spawn({
          file: plan.executable,
          args: plan.args,
          cwd: plan.cwd,
          env: plan.env,
          columns,
          rows,
        });
      } catch (error) {
        await environment.processes.cleanup(plan);
        throw error;
      }
      let exited!: () => void;
      const closed = new Promise<void>((resolve) => {
        exited = resolve;
      }).then(() => environment.processes.cleanup(plan));
      void closed.catch(() => {});
      const terminal: Terminal = {
        id: randomUUID(),
        scope,
        label: named ? command : `${command} (shell)`,
        cwd,
        createdAt: new Date().toISOString(),
        process: child,
        policy,
        closed,
        status: 'running',
        exitCode: null,
        output: '',
        total: 0,
        offset: 0,
        listeners: new Set(),
      };
      this.terms.set(terminal.id, terminal);
      child.onData((chunk) => {
        terminal.total += chunk.length;
        terminal.output = (terminal.output + chunk).slice(-RING_CHARS);
        terminal.offset = terminal.total - terminal.output.length;
        this.wake(terminal);
      });
      child.onExit(({ exitCode }) => {
        terminal.status = 'exited';
        terminal.exitCode = exitCode;
        exited();
        this.wake(terminal);
      });
      if (context.signal.aborted || this.closing || this.closedScopes.has(scope)) {
        await this.closeAndWait(terminal.id, scope);
        context.signal.throwIfAborted();
        this.assertOpen(scope);
      }
      return this.snapshot(terminal, 0);
    } finally {
      this.opening--;
    }
  }
  /** One read. `cursor` continues where a previous read stopped; `waitMs` waits for something new. */
  async read(
    id: string,
    scope: string,
    cursor = 0,
    waitMs = 0,
  ): Promise<{ snapshot: TerminalSnapshot; waited: boolean }> {
    const terminal = this.get(id, scope);
    const waited = await this.await(terminal, cursor, clampWait(waitMs));
    return { snapshot: this.snapshot(terminal, cursor), waited };
  }
  /**
   * Type into a terminal.
   *
   * `enter` defaults to true because the overwhelmingly common intent is "run this line": a terminal that
   * received `npm test` without a newline would sit there looking broken, and the model would have to know
   * that ConPTY wants `\r` while a POSIX tty wants `\n`. Sending the newline the platform's line discipline
   * expects is exactly the kind of thing the terminal tool should own. `enter: false` is for the other case:
   * a keypress, an escape sequence, an answer to a `(y/n)` prompt.
   */
  send(id: string, scope: string, input: string, enter: boolean): TerminalSnapshot {
    const terminal = this.get(id, scope);
    this.assertPolicy(terminal);
    if (terminal.status !== 'running')
      throw new Error(`Terminal already exited (code ${terminal.exitCode ?? 'unknown'})`);
    if (input.length > MAX_INPUT_CHARS)
      throw new Error(`Input is limited to ${MAX_INPUT_CHARS} characters per call`);
    const newline = process.platform === 'win32' ? '\r' : '\n';
    const text = enter && !/[\r\n]$/.test(input) ? input + newline : input;
    terminal.process.write(text);
    return this.snapshot(terminal, terminal.total);
  }
  /**
   * Interrupt or end what the terminal is running.
   *
   * `SIGINT` is written to the terminal as the interrupt character rather than signalled, because that is what
   * the key does and it is the only version that works everywhere: on POSIX the line discipline turns it into
   * a signal for the foreground job (not for the shell, which is what `kill` would reach), and on Windows
   * ConPTY there is no signal delivery at all, only this byte. The other two signals go to the process.
   */
  signal(id: string, scope: string, signal: TerminalSignal): TerminalSnapshot {
    // Validated here as well as in the schema: this is a public seam method, and `kill('SIGUSR1')` on a backend
    // that does not know the name is a worse failure than a refusal naming the three that work.
    if (!SIGNALS.includes(signal))
      throw new Error(`\`signal\` must be one of ${SIGNALS.join(', ')}`);
    const terminal = this.get(id, scope);
    this.assertPolicy(terminal);
    if (terminal.status !== 'running')
      throw new Error(`Terminal already exited (code ${terminal.exitCode ?? 'unknown'})`);
    if (signal === 'SIGINT') terminal.process.write('\x03');
    else this.beginStop(terminal, signal);
    return this.snapshot(terminal, terminal.total);
  }
  /** Close a terminal and everything it started. Idempotent: closing an exited terminal is a no-op. */
  close(id: string, scope: string): TerminalSnapshot {
    const terminal = this.get(id, scope);
    if (terminal.status === 'running') this.beginStop(terminal);
    this.wake(terminal);
    return this.snapshot(terminal, terminal.total);
  }
  /** Every terminal of a scope, or all of them when the host is shutting down. */
  closeAll(scope?: string): number {
    let closed = 0;
    for (const terminal of this.terms.values()) {
      if (scope !== undefined && terminal.scope !== scope) continue;
      if (terminal.status === 'running') {
        this.beginStop(terminal);
        closed++;
      }
      this.wake(terminal);
    }
    return closed;
  }
  private assertPolicy(terminal: Terminal): void {
    const config = resolveSandboxConfig();
    const current = currentExecutionPolicy() ?? executionPolicy(config.mode, config);
    if (JSON.stringify(current) !== JSON.stringify(terminal.policy))
      throw new Error(
        'Terminal creation policy differs from this call; close it and open a new terminal',
      );
  }
  private beginStop(terminal: Terminal, signal?: string): void {
    if (terminal.stopping) return;
    try {
      if (terminal.process.terminate) {
        terminal.stopping = terminal.process.terminate();
      } else {
        terminal.process.kill(signal);
        terminal.stopping = Promise.resolve();
      }
    } catch (error) {
      terminal.stopping = Promise.reject(error);
    }
    void terminal.stopping.catch(() => {});
  }
  private async join(terminal: Terminal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([terminal.stopping, terminal.closed]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Terminal process exit was not confirmed')),
            10000,
          );
        }),
      ]);
    } catch (cause) {
      const error = new Error('Terminal cleanup is unconfirmed: ' + String(cause));
      error.name = 'ToolCleanupError';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async closeAndWait(id: string, scope: string): Promise<TerminalSnapshot> {
    this.close(id, scope);
    const terminal = this.get(id, scope);
    await this.join(terminal);
    return this.snapshot(terminal, terminal.total);
  }
  async closeAllAndWait(scope?: string): Promise<number> {
    if (scope === undefined) this.closing = true;
    else this.closedScopes.add(scope);
    await Promise.allSettled(
      [...this.pending.entries()]
        .filter(([, owner]) => scope === undefined || owner === scope)
        .map(([pending]) => pending),
    );
    const count = this.closeAll(scope);
    const results = await Promise.allSettled(
      [...this.terms.values()]
        .filter((t) => scope === undefined || t.scope === scope)
        .map((t) => this.join(t)),
    );
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return count;
  }
  private liveCount(): number {
    return [...this.terms.values()].filter((terminal) => terminal.status === 'running').length;
  }
  private wake(terminal: Terminal): void {
    for (const listener of [...terminal.listeners]) listener();
  }
  /**
   * Wait for output after `cursor`, or for the terminal to exit.
   *
   * Returns whether anything happened. A wait that times out is not an error — "nothing has been printed yet"
   * is the answer a REPL gives most of the time — which is why the result says so instead of failing the call.
   */
  private async await(terminal: Terminal, cursor: number, waitMs: number): Promise<boolean> {
    if (waitMs <= 0 || terminal.status !== 'running' || terminal.total > cursor) return false;
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (waited: boolean) => {
        clearTimeout(timer);
        terminal.listeners.delete(listener);
        resolve(waited);
      };
      const listener = () => done(true);
      terminal.listeners.add(listener);
      timer = setTimeout(() => done(false), waitMs);
    });
  }
  private openTool(scope: string): Tool {
    return {
      name: 'terminal_open',
      permission: 'command',
      description:
        'Open an interactive terminal: a real pseudo-terminal on the host, for programs that need one — a REPL, a debugger, an interactive rebase, a prompt waiting for an answer. It stays open across steps and across runs of this session until you close it, so use it instead of run_command when the program expects to be talked to. Without `command` it is the platform shell. Read with terminal_read, type with terminal_send, interrupt with terminal_signal. Available with host or Windows execution backends; containers remain unsupported. The terminal keeps its creation policy and cannot be steered after a policy switch.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description:
              'Program to run, for example "python3" or "git" — one program, never a command line (pass its arguments in `args`). Omit for the platform shell.',
          },
          args: {
            type: 'array',
            maxItems: MAX_ARGS,
            items: { type: 'string', maxLength: MAX_ARG_CHARS },
            description:
              'Arguments for `command`, for example ["rebase", "-i", "HEAD~3"]. Each one is passed as its own argv entry, so spaces inside an argument are fine.',
          },
          cwd: { type: 'string', minLength: 1, maxLength: 4096 },
          columns: { type: 'integer', minimum: 20, maximum: 500 },
          rows: { type: 'integer', minimum: 5, maximum: 200 },
        },
        additionalProperties: false,
      },
      // An arrow function on purpose: the tool's `this` must be the manager, not the tool object.
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const snapshot = await this.open(args, context, scope);
          return {
            isError: false,
            content: [
              `Terminal ${snapshot.id} started (${snapshot.label}) in ${snapshot.cwd}.`,
              'It keeps running between steps. Read its output with terminal_read (wait_ms is how you wait for something to happen), type with terminal_send, and close it with terminal_close when the work is done — a terminal left open holds a process.',
            ].join('\n'),
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
  private listTool(scope: string): Tool {
    return {
      name: 'terminal_list',
      description:
        'List the terminals this session has open, with their status, process id and how much output each has produced. Use it after a resumed run to find a terminal that is still around, or to check what is still running before closing anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, context) => {
        context.signal.throwIfAborted();
        try {
          const terminals = this.list(scope);
          if (!terminals.length)
            return {
              isError: false,
              content: 'No terminals open in this session. Open one with terminal_open.',
            };
          return {
            isError: false,
            content: terminals
              .map(
                (terminal) =>
                  `${terminal.id}  ${terminal.status}${terminal.status === 'exited' ? ` (exit ${terminal.exitCode ?? 'unknown'})` : ''}  pid ${terminal.pid ?? '?'}  ${terminal.label}  in ${terminal.cwd}  ${terminal.nextCursor} char(s) of output`,
              )
              .join('\n'),
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
  private readTool(scope: string): Tool {
    return {
      name: 'terminal_read',
      description:
        'Read what a terminal has printed since a cursor, and whether it has exited. `cursor` is the `nextCursor` from the previous read (0 for "from the beginning of what is still buffered"); `wait_ms` waits for new output instead of returning immediately — the way to wait for a prompt, a test run or a build to say something without polling in a loop. Output older than the terminal buffer is reported as truncated.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          cursor: { type: 'integer', minimum: 0 },
          wait_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const { snapshot, waited } = await this.read(
            String(args.id).trim(),
            scope,
            Number(args.cursor ?? 0),
            Number(args.wait_ms ?? 0),
          );
          const notes = [
            `terminal ${snapshot.id}  ${snapshot.status}${snapshot.status === 'exited' ? ` (exit ${snapshot.exitCode ?? 'unknown'})` : ''}  cursor ${snapshot.nextCursor}`,
          ];
          if (snapshot.truncated)
            notes.push('[earlier output was dropped from the terminal buffer]');
          notes.push(snapshot.output.length ? snapshot.output : waited ? '' : '[no new output]');
          if (waited) notes.push('[waited: new output arrived]');
          return { isError: false, content: bounded(notes.filter(Boolean).join('\n')) };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
  private sendTool(scope: string): Tool {
    return {
      name: 'terminal_send',
      permission: 'command',
      description:
        'Type into a terminal, by default followed by the newline that runs the line. Use `enter: false` to send something that is not a line — a keypress, an escape sequence, an answer to a prompt that is read character by character. Read the result with terminal_read; nothing about this call waits for it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          input: { type: 'string', maxLength: MAX_INPUT_CHARS },
          enter: {
            type: 'boolean',
            description: 'Append a newline, so the shell runs the line. Defaults to true.',
          },
        },
        required: ['id', 'input'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const snapshot = this.send(
            String(args.id).trim(),
            scope,
            String(args.input ?? ''),
            args.enter !== false,
          );
          return {
            isError: false,
            content: `Sent to terminal ${snapshot.id}. Read the result with terminal_read({ id: "${snapshot.id}", cursor: ${snapshot.nextCursor}, wait_ms: 5000 }).`,
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
  private signalTool(scope: string): Tool {
    return {
      name: 'terminal_signal',
      permission: 'command',
      description:
        'Interrupt or end what a terminal is running: SIGINT is the interrupt key (Ctrl-C), SIGTERM and SIGKILL end the process itself. Use SIGINT to stop a running command and get the prompt back, and SIGKILL only when the program ignores everything else. It does not close the terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          signal: { type: 'string', enum: [...SIGNALS] },
        },
        required: ['id', 'signal'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const signal = String(args.signal) as TerminalSignal;
          if (!SIGNALS.includes(signal))
            return {
              isError: true,
              content: `\`signal\` must be one of ${SIGNALS.join(', ')}.`,
            };
          const id = String(args.id).trim();
          this.signal(id, scope, signal);
          if (signal !== 'SIGINT') await this.join(this.get(id, scope));
          const terminal = this.get(id, scope);
          const snapshot = this.snapshot(terminal, terminal.total);
          return {
            isError: false,
            content: `Sent ${signal} to terminal ${snapshot.id} (${snapshot.status}). Read what it printed with terminal_read.`,
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
  private closeTool(scope: string): Tool {
    return {
      name: 'terminal_close',
      permission: 'command',
      description:
        'Close a terminal and everything it started. Use it as soon as the interactive work is done: a terminal that is left open keeps a process alive for the rest of the session, and the next run inherits it.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const snapshot = await this.closeAndWait(String(args.id).trim(), scope);
          return {
            isError: false,
            content: `Terminal ${snapshot.id} closed (${snapshot.nextCursor} characters of output were recorded).`,
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'ToolCleanupError') throw error;
          return failure(error);
        }
      },
    };
  }
}
function clampDimension(value: unknown, fallback: number): number {
  const size = Number(value);
  return Number.isFinite(size) ? Math.min(500, Math.max(5, Math.trunc(size))) : fallback;
}
function clampWait(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(ms))) : 0;
}
