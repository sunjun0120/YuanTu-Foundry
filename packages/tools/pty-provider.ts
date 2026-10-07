import { killTree } from './process.ts';
/**
 * The terminal *seam*: what a PTY backend is, and who decides which one a terminal gets.
 *
 * Terminals are the one tool family that cannot be built on the command runner. A command is a program that
 * runs to completion and whose output is a byte stream; a terminal is a *conversation* with a shell that stays
 * open, echoes what it is told, wraps its output at a width, and asks questions — a REPL, a `git rebase -i`, a
 * debugger, a password prompt. None of that can be faked with pipes: the shell has to believe it is talking to
 * a person, which means a real pseudo-terminal.
 *
 * That makes a native dependency the only implementation, and a native dependency is a thing that can be
 * missing: a failed prebuild, a platform nobody packaged for, an operator who installed with
 * `--ignore-scripts`. Three decisions follow, and they are why this is a seam rather than a hard import:
 *
 * 1. **The module is imported at the moment a terminal is opened, never at module load.** `createTools` builds
 *    the whole catalogue on every host, including hosts that will never open a terminal; a failed dynamic
 *    import there would take down every tool in the product. So the failure belongs to `terminal_open` and it
 *    is reported as a message a person can act on: install the optional dependency, or do not use terminals.
 * 2. **Availability is an answer, not an exception.** `available()` resolves to a line explaining why this
 *    backend cannot run here, or `null` when it can. That is the shape `terminal_list` and `terminal_open`
 *    report, and the shape an embedder's own backend has to fill in.
 * 3. **An embedder can replace the backend.** `registerPtyProvider` is the hook: a test drives terminals with a
 *    scripted provider, and a product that already has a PTY implementation (an Electron app with a terminal
 *    panel, say) registers it instead of shipping a second one.
 *
 * The seam deliberately does *not* model everything a PTY can do. There is no flow control, no window resize,
 * no process-group control beyond `signal`: this is the surface the terminal tools actually use, and a seam
 * member nothing asks about is a promise with no reader.
 */
/** One running pseudo-terminal. The subset of a node-pty handle this project uses. */
export interface PtyProcess {
  pid: number;
  /** Chunks as they arrive, already decoded to text by the backend. */
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number | null; signal?: number }) => void): void;
  write(data: string): void;
  resize?(columns: number, rows: number): void;
  /** Ends the terminal. `signal` is a name like `SIGINT`; backends that cannot send one may kill instead. */
  kill(signal?: string): void;
  /** Await termination of the owned OS process tree. Optional for in-memory adapters. */
  terminate?(): Promise<void>;
}
export interface PtyRequest {
  /** The program to run. A terminal with no shell is a terminal nobody can type in. */
  file: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  columns: number;
  rows: number;
}
export interface PtyProvider {
  /** The name `YUANTU_PTY` selects, and what a failure message names. */
  name: string;
  /** One line for an operator: what this backend runs, and what it needs installed. */
  description: string;
  available(): Promise<string | null>;
  spawn(request: PtyRequest): Promise<PtyProcess>;
}
const registry = new Map<string, PtyProvider>();
/** Registers a backend under its own name, replacing any previous one — the hook an embedder needs. */
export function registerPtyProvider(provider: PtyProvider): void {
  registry.set(provider.name, provider);
}
/** The backend named by `YUANTU_PTY`, or the built-in one. Throws only when nothing is registered at all. */
export function ptyProvider(env: NodeJS.ProcessEnv = process.env): PtyProvider {
  const name = env.YUANTU_PTY ?? NODE_PTY;
  const provider = registry.get(name);
  if (!provider)
    throw new Error(
      `No PTY provider named "${name}" is registered (known: ${[...registry.keys()].join(', ') || 'none'})`,
    );
  return provider;
}
export function ptyProviders(): PtyProvider[] {
  return [...registry.values()];
}
/** The built-in backend's name. Also the default, because it is the only one that ships. */
export const NODE_PTY = 'node-pty';
/**
 * The built-in backend: `@lydell/node-pty`, an optional dependency with prebuilt binaries.
 *
 * Both methods import it lazily and report a failed import as a message rather than as a throw at module load
 * — see the header. `available()` is what the tools call before promising anything, so the "not installed"
 * case is answered once, in one place, with the install command in it.
 */
export const nodePtyProvider: PtyProvider = {
  name: NODE_PTY,
  description:
    'A real pseudo-terminal from @lydell/node-pty (prebuilt; Windows uses ConPTY). The session execution backend supplies the executable, including the Windows restricted-token launcher.',
  async available() {
    try {
      await import('@lydell/node-pty');
      return null;
    } catch (error) {
      return `@lydell/node-pty is not available (${error instanceof Error ? error.message : String(error)}). It is an optional dependency: install it with \`npm install @lydell/node-pty\`, or set YUANTU_PTY to a provider that is registered.`;
    }
  },
  async spawn(request) {
    const pty = await import('@lydell/node-pty');
    const child = pty.spawn(request.file, [...(request.args ?? [])], {
      name: 'xterm-256color',
      cols: request.columns,
      rows: request.rows,
      cwd: request.cwd,
      env: request.env as Record<string, string>,
    });
    let exited = false;
    child.onExit(() => {
      exited = true;
    });
    if (process.platform === 'win32') {
      // node-pty's natural-exit path drains output but leaves the ConPTY input socket
      // and output worker alive (microsoft/node-pty#887, #947, #965). Public kill()
      // also sweeps process IDs, which is inappropriate after the process exited.
      // Keep this compatibility shim inside the native adapter, after output drains.
      const native = child as typeof child & {
        _agent?: {
          _inSocket?: { destroy(): void };
          _conoutSocketWorker?: { dispose(): void };
        };
      };
      child.onExit(() => {
        native._agent?._inSocket?.destroy();
        native._agent?._conoutSocketWorker?.dispose();
      });
    }
    return {
      pid: child.pid,
      terminate: async () => {
        if (exited) return;
        try {
          await killTree(child.pid);
        } catch (error) {
          if (!exited) throw error;
        }
        if (!exited) child.kill();
      },
      onData: (listener) => child.onData(listener),
      onExit: (listener) => child.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
      write: (data) => child.write(data),
      resize: (columns, rows) => child.resize(columns, rows),
      kill: (signal) => {
        // A named signal needs the numeric value on POSIX; node-pty accepts either. On Windows there is no
        // signal delivery, so anything other than a plain kill is reported by the exit itself.
        if (signal && process.platform !== 'win32') child.kill(signal);
        else child.kill();
      },
    };
  },
};
registerPtyProvider(nodePtyProvider);
