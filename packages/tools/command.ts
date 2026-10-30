import { stopSandbox, cleanupSandbox, markSandboxStarted } from '../sandbox/sandbox.ts';
import { spawn } from 'node:child_process';
import type { Tool } from '../protocol/index.ts';
import { toolOutput } from '../protocol/tool-result.ts';
import type { ToolOutputContract } from '../protocol/tool-result.ts';
import { MAX_TOOL_OUTPUT } from './registry.ts';
import { Workspace } from './files.ts';
import { localExecutionEnvironment, executionPolicy } from './execution-environment.ts';
import { resolveSandboxConfig } from '../sandbox/sandbox.ts';
import { createOutputDecoder } from './output-decoder.ts';
import {
  SANDBOX_CHILD_SPAWN_NOTE,
  WINDOWS_ACCOUNT_ACCESS_NOTE,
  sandboxChildSpawnBlocked,
  windowsAccountAccessDenied,
} from '../sandbox/sandbox-launch-failure.ts';

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
      sandboxNote: {
        type: 'string',
        description: 'Why the Windows sandbox could not start this command’s child process.',
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
      'Run an approved shell command and wait for it: the default for any command that finishes on its own (tests, builds, git, scripts, one-off reads), returning stdout, stderr and exit code in one step. Not for reading, listing or searching files: read_file, list_files and search_files do that without an approval. Runs under the selected execution backend and its file/network policy (native isolation is platform-dependent; host mode is unrestricted). Do not detach or background the process; for a server or watcher that keeps running, use start_command. The native sandbox blocks the network by default; set network to true only for a command that genuinely needs it (installing dependencies, fetching), which asks the user to approve that one command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 16_000 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 300_000 },
        network: {
          type: 'boolean',
          description:
            'Run this one command with network access when the sandbox otherwise blocks it. Requires approval.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    requestsNetwork: (args) => args.network === true,
    async execute(args, ctx) {
      const command = String(args.command);
      const cwd = await new Workspace(root).resolve(String(args.cwd ?? '.'));
      ctx.signal.throwIfAborted();
      const config = resolveSandboxConfig();
      const environment = await localExecutionEnvironment(
        root,
        ctx.executionPolicy ?? executionPolicy(config.mode, config),
      );
      ctx.signal.throwIfAborted();
      const plan = await environment.processes.prepare(
        invocation?.command ?? command,
        cwd,
        invocation?.argv,
        ctx.signal,
      );
      /**
       * An abort arriving between the plan and the spawn still has a plan to release.
       *
       * `prepare` is not a dry run: a native backend has already acquired scratch and may hold workspace ACL
       * grants. Nothing downstream runs when this throws, so this is the only place the plan can be handed back.
       */
      try {
        ctx.signal.throwIfAborted();
      } catch (error) {
        await cleanupSandbox(plan).catch(() => undefined);
        throw error;
      }
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        markSandboxStarted(plan);
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
        // One decoder per stream: a character split across two chunks is joined, and a console program writing
        // in the Windows OEM code page is read in it (see `createOutputDecoder`).
        const decoders = { stdout: createOutputDecoder(), stderr: createOutputDecoder() };
        const collect = (target: 'stdout' | 'stderr', text: string) => {
          if (!text) return;
          if (output.length >= COMMAND_OUTPUT_LIMIT) {
            truncated = true;
            return;
          }
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
        child.stdout.on('data', (chunk: Buffer) => collect('stdout', decoders.stdout.write(chunk)));
        child.stderr.on('data', (chunk: Buffer) => collect('stderr', decoders.stderr.write(chunk)));
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
            /**
             * A spawn that never produced a process still produced the plan, and the `close` handler below
             * returns immediately once `settled` is set — so this is the only place that can release it. Without
             * it every failed spawn (a missing executable, a refusal) leaked the container and, on a copying
             * backend, a whole copy of the workspace, with nothing left to reclaim either. The cleanup is awaited
             * so the caller is not told the attempt is over while it is still being torn down.
             */
            void cleanupSandbox(plan)
              .catch(() => undefined)
              .then(() => reject(error));
          }
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          collect('stdout', decoders.stdout.end());
          collect('stderr', decoders.stderr.end());
          void (async () => {
            if (killing) await killing;
            else await stopSandbox(child, plan);
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
            /**
             * A Windows-sandboxed command that could not fork says so in words.
             *
             * The raw `spawn EPERM` stack is the only evidence today, and it reads as "the test runner is broken".
             * The note names the environment and the way on; it is added only when the backend that ran this
             * command is the Windows one and the output carries the signature.
             */
            const childSpawnBlocked =
              plan.backend === 'windows' &&
              !timedOut &&
              code !== 0 &&
              sandboxChildSpawnBlocked(`${stdout}\n${stderr}`);
            // The account backend refuses anything outside the workspace and the discovered toolchain roots; a tool
            // that runs into that names the settings page that adds the directory instead of looking broken.
            const accessDenied =
              plan.backend === 'windows-account' &&
              !timedOut &&
              code !== 0 &&
              windowsAccountAccessDenied(`${stdout}\n${stderr}`);
            const sandboxNote = childSpawnBlocked
              ? SANDBOX_CHILD_SPAWN_NOTE
              : accessDenied
                ? WINDOWS_ACCOUNT_ACCESS_NOTE
                : undefined;
            resolve({
              isError: timedOut || code !== 0,
              commandExecuted: true,
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
                ...(sandboxNote ? { sandboxNote } : {}),
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
                ...(sandboxNote ? { sandboxNote } : {}),
              }),
            });
          })().catch(reject);
        });
      });
    },
  };
}
