import { stopSandbox, cleanupSandbox } from './sandbox.ts';
import { spawn } from 'node:child_process';
import type { Tool } from '../protocol/index.ts';
import { toolOutput } from '../protocol/tool-result.ts';
import type { ToolOutputContract } from '../protocol/tool-result.ts';
import { MAX_TOOL_OUTPUT } from './registry.ts';
import { Workspace } from './files.ts';
import { localExecutionEnvironment, executionPolicy } from './execution-environment.ts';
import { resolveSandboxConfig } from './sandbox.ts';

/**
 * How much command output is held in memory before collection stops. Well above the tool-result limit, so
 * the overflow exists as text the result stage can spill; bounded, because a runaway command must not be
 * able to grow this process without limit.
 */
const COMMAND_OUTPUT_LIMIT = 2_000_000;

/**
 * `run_command`'s declared result shape.
 *
 * The text form retains the merged `output` for ordering and compatibility, and includes bounded stdout/
 * stderr summaries so the model can identify which stream produced a line. The card carries larger stream
 * excerpts. Neither merged text nor a truncated excerpt can reconstruct an omitted channel afterwards.
 *
 * `stdout` and `stderr` here are each capped at `MAX_TOOL_OUTPUT`, the size at which the text form stops being
 * a result and becomes a spill. Without a cap, a verbose build would put two megabytes of output on the live
 * channel and in the session log — for a payload the model never sees — while the model itself was shown
 * twenty-four thousand characters of the same command. `truncated` says the streams below are not all of it,
 * whether the collector's own limit cut them or this cap did.
 */
const RUN_COMMAND_OUTPUT: ToolOutputContract = {
  render: 'command-output',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command as it was requested.' },
      exitCode: { type: ['integer', 'null'], description: 'Null when the child was killed.' },
      signal: { type: ['string', 'null'], description: 'The signal that ended the child, if any.' },
      timedOut: { type: 'boolean', description: 'True when this call hit its own timeout.' },
      durationMs: { type: 'integer', minimum: 0 },
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      truncated: {
        type: 'boolean',
        description: 'True when the streams are not the whole output.',
      },
    },
    required: [
      'command',
      'exitCode',
      'signal',
      'timedOut',
      'durationMs',
      'stdout',
      'stderr',
      'truncated',
    ],
    additionalProperties: false,
  },
};

export function commandTool(root: string, invocation?: { command: string; argv: string[] }): Tool {
  return {
    name: 'run_command',
    permission: 'command',
    output: RUN_COMMAND_OUTPUT,
    description:
      'Run an approved shell command. Docker mode uses Linux /bin/sh, no network and a read-only workspace; host mode is NOT sandboxed. Use foreground commands, no detached/background jobs. Reports actual stdout, stderr and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 16_000 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 300_000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const command = String(args.command);
      const cwd = await new Workspace(root).resolve(String(args.cwd ?? '.'));
      ctx.signal.throwIfAborted();
      const config = resolveSandboxConfig();
      const environment = await localExecutionEnvironment(
        root,
        ctx.executionPolicy ?? executionPolicy(config.mode, { image: config.image }),
      );
      const plan = await environment.processes.prepare(
        invocation?.command ?? command,
        cwd,
        invocation?.argv,
        ctx.signal,
      );
      ctx.signal.throwIfAborted();
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        const child = spawn(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '',
          stdout = '',
          stderr = '',
          truncated = false,
          timedOut = false,
          settled = false,
          killing: Promise<void> | undefined;
        let cleanupError: Error | undefined;
        // Collection stops well above the size a tool result can carry, because the result stage is what
        // decides what to do with the overflow: the full text goes to the session's spill file and the
        // result points at it. Stopping at the result limit here would drop the tail of a build log — the
        // part that says why it failed — before anything could preserve it.
        const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
          if (output.length >= COMMAND_OUTPUT_LIMIT) {
            truncated = true;
            return;
          }
          const text = chunk.toString('utf8');
          // What the merged text keeps is what each stream copy keeps, so the two stay a partition of `output`
          // rather than a second, longer copy of the same bytes: a card's stdout plus its stderr is exactly the
          // text the model was given, and the payload cannot outgrow the result it belongs to by construction.
          const appended =
            text.length > COMMAND_OUTPUT_LIMIT - output.length
              ? text.slice(0, COMMAND_OUTPUT_LIMIT - output.length)
              : text;
          output += appended;
          if (target === 'stdout') stdout += appended;
          else stderr += appended;
          if (appended.length < text.length) truncated = true;
        };
        child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
        child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
        const stop = () => {
          if (child.pid && !killing)
            killing = stopSandbox(child, plan).catch((error) => {
              cleanupError = new Error(error instanceof Error ? error.message : String(error));
              cleanupError.name = 'ToolCleanupError';
              child.kill();
              child.stdout.destroy();
              child.stderr.destroy();
            });
        };
        const timer = setTimeout(
          () => {
            timedOut = true;
            stop();
          },
          Number(args.timeout_ms ?? 60_000),
        );
        const abort = () => stop();
        ctx.signal.addEventListener('abort', abort, { once: true });
        if (ctx.signal.aborted) stop();
        const cleanup = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', abort);
        };
        child.on('error', (error) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          void (async () => {
            if (killing) await killing;
            else await cleanupSandbox(plan);
            if (cleanupError) {
              reject(cleanupError);
              return;
            }
            if (ctx.signal.aborted) {
              reject(ctx.signal.reason);
              return;
            }
            const shownStdout = stdout.slice(0, MAX_TOOL_OUTPUT);
            const shownStderr = stderr.slice(0, MAX_TOOL_OUTPUT);
            resolve({
              isError: timedOut || code !== 0,
              /**
               * `truncated` is the tool's own declaration that what it hands over is not the whole output.
               *
               * The structured payload below has carried this flag all along for the card; the *text* had only a
               * sentence in it, which the result stage could not read — so it spilled the captured text under a
               * notice promising "the full N bytes". Same fact, said where the code that needs it can see it.
               */
              ...(truncated ? { truncated: true } : {}),
              content: JSON.stringify({
                exitCode: code,
                signal,
                timedOut,
                stdout: stdout.slice(0, 6000),
                stderr: stderr.slice(0, 6000),
                streamsTruncated: truncated || stdout.length > 6000 || stderr.length > 6000,
                // The result stage truncates and spills this; collecting more here only means the tail of a
                // long output survives long enough to be written somewhere the model can read it.
                output: truncated
                  ? `${output}\n[command output exceeded ${COMMAND_OUTPUT_LIMIT} characters]`
                  : output,
              }),
              // A non-zero exit is still a result with a shape, so it carries one: a card shows the exit code
              // and the streams for a failed command, which is exactly when somebody wants to read them. Only a
              // call that produced no value at all — refused, or a body that threw — has no payload.
              output: toolOutput(RUN_COMMAND_OUTPUT, {
                command,
                exitCode: code,
                signal,
                timedOut,
                durationMs: Math.round(performance.now() - startedAt),
                stdout: shownStdout,
                stderr: shownStderr,
                truncated:
                  truncated ||
                  shownStdout.length < stdout.length ||
                  shownStderr.length < stderr.length,
              }),
            });
          })().catch(reject);
        });
      });
    },
  };
}
