import { realpath } from 'node:fs/promises';
import { Workspace, fileTools } from './files.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from '../protocol/index.ts';
import { prepareSandbox, sandboxProvider, cleanupSandbox, stopSandbox } from './sandbox.ts';
import type { ExecutionPolicy, ExecutionCapabilities } from '../protocol/execution.ts';
import { snapshotExecutionPolicy } from './execution-policy.ts';
export {
  executionPolicy,
  withExecutionPolicy,
  requireExecutionCapabilities,
} from './execution-policy.ts';

/** A paired local backend: commands and file operations share the same canonical path identity. */
export async function localExecutionEnvironment(root: string, policy: ExecutionPolicy) {
  const canonical = await realpath(root);
  const fixed = snapshotExecutionPolicy(policy);
  const workspace = new Workspace(canonical);
  const prepare = async (
    command: string,
    cwd = '.',
    argv?: readonly string[],
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => {
    signal?.throwIfAborted();
    const working = await workspace.resolve(cwd);
    const unavailable = await sandboxProvider(fixed.mode).available();
    if (unavailable) throw new Error(unavailable);
    signal?.throwIfAborted();
    const plan = await prepareSandbox(
      canonical,
      working,
      command,
      argv,
      {
        mode: fixed.mode,
        image: fixed.image,
      },
      'command',
      env,
    );
    if (signal?.aborted) {
      await cleanupSandbox(plan);
      signal.throwIfAborted();
    }
    return plan;
  };
  return Object.freeze({
    identity: Object.freeze({ kind: 'local' as const, root: canonical }),
    policy: fixed,
    capabilities: Object.freeze({
      processFiles: fixed.processFiles,
      network: fixed.network,
      pathKind: 'local',
      links: 'refused',
    } satisfies ExecutionCapabilities),
    files: Object.freeze({
      resolve: workspace.resolve.bind(workspace),
      read: workspace.read.bind(workspace),
      walk: workspace.walk.bind(workspace),
      /** Creates a file through the existing preparation/approval/journal pipeline, never a raw write. */
      async write(input: string, content: string, context: ToolContext) {
        const registry = new ToolRegistry();
        for (const tool of fileTools(canonical)) registry.register(tool);
        try {
          return await registry.execute(
            {
              id: context.callId ?? randomUUID(),
              name: 'write_file',
              arguments: { path: input, content },
            },
            { ...context, executionPolicy: fixed },
          );
        } finally {
          await registry.close();
        }
      },
    }),
    processes: Object.freeze({
      prepare,
      async start(
        program: string,
        argv: readonly string[],
        cwd = '.',
        signal?: AbortSignal,
        env?: NodeJS.ProcessEnv,
      ) {
        const plan = await prepare(program, cwd, argv, signal, env);
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(plan.executable, plan.args, {
            cwd: plan.cwd,
            env: plan.env,
            windowsHide: true,
            windowsVerbatimArguments: plan.windowsVerbatimArguments,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (error) {
          await cleanupSandbox(plan);
          throw error;
        }
        let stopping: Promise<void> | undefined;
        const stop = () => (stopping ??= stopSandbox(child, plan));
        const abort = () => {
          void stop().catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            let spawnError: Error | undefined;
            child.once('error', (error) => {
              spawnError = error;
            });
            child.once('close', (code, exitSignal) => {
              signal?.removeEventListener('abort', abort);
              void (async () => {
                if (stopping) await stopping;
                await cleanupSandbox(plan);
                if (spawnError) throw spawnError;
                return { code, signal: exitSignal };
              })().then(resolve, reject);
            });
          },
        );
        // Consumers may subscribe later; retain the rejection without causing an unhandled rejection.
        void closed.catch(() => {});
        return { child, plan, closed, stop };
      },
      cleanup: cleanupSandbox,
      stop: stopSandbox,
    }),
  });
}
