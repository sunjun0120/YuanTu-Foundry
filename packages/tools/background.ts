import { cleanupSandbox, markSandboxStarted, type SandboxPlan } from './sandbox.ts';
import { localExecutionEnvironment, executionPolicy } from './execution-environment.ts';
import { resolveSandboxConfig } from './sandbox.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CommandJournal, JobProducer, JobSnapshot } from '../protocol/jobs.ts';
import type { Tool, ToolContext } from '../protocol/index.ts';
import { Workspace } from './files.ts';
import { killTree } from './process.ts';
import { toolEnvironment } from './environment.ts';
import { snapshotExecutionPolicy } from './execution-policy.ts';
import type { ExecutionPolicy } from '../protocol/execution.ts';
/**
 * How much of a command's output is kept once the process is gone.
 *
 * The same window the ring answers with (`snapshot`), so a recall after a restart returns what a read of a live
 * command would have: the end of the output, which is where a build's failure is. Recording the whole ring would
 * put a second, unbounded copy of every command's output into the session log, and the log is not a log if its
 * size is decided by how chatty a program is.
 */
const SETTLED_TAIL = 3000;
interface Job {
  plan: SandboxPlan;
  policy: ExecutionPolicy;
  id: string;
  scope: string;
  command: string;
  cwd: string;
  createdAt: string;
  finishedAt?: string;
  worker: ChildProcess;
  status: string;
  pid?: number;
  exitCode: number | null;
  output: string;
  total: number;
  offset: number;
  done: Promise<void>;
  cleanupFailed: boolean;
  processClosed?: boolean;
  cleanup?: Promise<void>;
  finalStatus?: string;
  inputs: Map<string, { resolve: () => void; reject: (e: Error) => void }>;
  /** Set the first time the outcome is recorded, so a second `close` cannot write it twice. */
  settled?: boolean;
  /**
   * The session's durable record of this command, captured from the call that started it.
   *
   * Held on the job rather than looked up when it settles, because settlement happens in the worker's `exit`
   * handler — which may run in a later turn, long after the call that started the command returned. The seam
   * belongs to the run that had the session; the job is what keeps it alive until the process is done.
   */
  journal?: CommandJournal;
}
async function wait(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, ms);
        abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export class BackgroundCommands {
  private jobs = new Map<string, Job>();
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private get(id: string, scope: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.scope !== scope) throw new Error('Unknown background command');
    return job;
  }
  /**
   * Write a command's outcome into its session's log, once.
   *
   * The tail rather than the ring: what survives the process is what a reader needs to see how it ended, and the
   * total with it, so the tail can be read as a tail instead of as everything the command said. A command started
   * by a run with no session seam records nothing, which is the behaviour every embedder had before this existed.
   */
  private settle(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    job.journal?.settled({
      id: job.id,
      sessionId: job.scope,
      status: job.status,
      cleanupConfirmed: !job.cleanupFailed && job.plan.processTree !== 'process-group',
      exitCode: job.exitCode,
      finishedAt: job.finishedAt ?? new Date().toISOString(),
      output: job.output.slice(-SETTLED_TAIL),
      outputChars: job.total,
    });
  }
  private snapshot(job: Job, cursor = 0) {
    if (cursor > job.total) throw new Error('Invalid output cursor');
    const start = Math.max(cursor, job.offset),
      output = job.output.slice(start - job.offset, start - job.offset + 3000);
    return {
      id: job.id,
      sessionId: job.scope,
      command: job.command,
      cwd: job.cwd,
      createdAt: job.createdAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      status: job.status,
      pid: job.pid,
      exitCode: job.exitCode,
      output,
      nextCursor: start + output.length,
      truncated: cursor < job.offset,
    };
  }
  list(scope?: string) {
    return [...this.jobs.values()]
      .filter((job) => scope === undefined || job.scope === scope)
      .map((job) => this.snapshot(job, job.total));
  }
  /**
   * This manager as a job producer, so commands answer `job_list` / `job_output` / `job_kill` through the
   * same surface as every other kind of long-running work. The output ring is not duplicated here: every
   * method delegates to the one that already owns it.
   */
  jobProducer(): JobProducer {
    const adapt = (snapshot: ReturnType<BackgroundCommands['snapshot']>): JobSnapshot => ({
      id: snapshot.id,
      kind: 'command',
      sessionId: snapshot.sessionId,
      label: snapshot.command,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
      ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
      exitCode: snapshot.exitCode,
      output: snapshot.output,
      nextCursor: snapshot.nextCursor,
      truncated: snapshot.truncated,
      detail: { cwd: snapshot.cwd },
    });
    return {
      kind: 'command',
      // Ownership is the scope test the manager already makes: a command of another session is not unknown,
      // it belongs to a different caller.
      owns: ({ id, scope }) => this.jobs.get(id)?.scope === scope,
      list: (scope) => this.list(scope).map(adapt),
      output: async ({ id, scope, cursor, waitMs, signal }) =>
        adapt(await this.poll(id, scope, cursor, waitMs, signal)),
      kill: async ({ id, scope }) => adapt(await this.stopById(id, scope)),
    };
  }
  async poll(id: string, scope: string, cursor = 0, waitMs = 0, signal?: AbortSignal) {
    const job = this.get(id, scope);
    await wait(job.done, waitMs, signal);
    return this.snapshot(job, cursor);
  }
  async stopById(id: string, scope: string) {
    const job = this.get(id, scope);
    await this.stop(job);
    return this.snapshot(job, job.total);
  }
  clear(scope?: string): number {
    let cleared = 0;
    for (const [id, job] of this.jobs) {
      if (
        (scope === undefined || job.scope === scope) &&
        !['starting', 'running', 'finishing'].includes(job.status)
      ) {
        this.jobs.delete(id);
        cleared++;
      }
    }
    return cleared;
  }
  private async start(args: Record<string, unknown>, ctx: ToolContext, scope: string) {
    const cwd = await new Workspace(this.root).resolve(String(args.cwd ?? '.'));
    ctx.signal.throwIfAborted();
    const config = resolveSandboxConfig();
    const environment = await localExecutionEnvironment(
      this.root,
      ctx.executionPolicy ?? executionPolicy(config.mode, config),
    );
    const plan = await environment.processes.prepare(
      String(args.command),
      cwd,
      undefined,
      ctx.signal,
    );
    /**
     * The plan is real before the job is, so both refusals below have to hand it back.
     *
     * `prepare` can acquire a workspace permission lease and create private scratch. Refusals before
     * registration must release the original plan immediately.
     */
    try {
      ctx.signal.throwIfAborted();
    } catch (error) {
      await cleanupSandbox(plan).catch(() => undefined);
      throw error;
    }
    if (
      [...this.jobs.values()].filter((j) => ['starting', 'running', 'finishing'].includes(j.status))
        .length >= 8
    ) {
      await cleanupSandbox(plan).catch(() => undefined);
      throw new Error('Background command limit is 8');
    }
    while (this.jobs.size >= 32) {
      const old = [...this.jobs.values()].find(
        (j) => !['starting', 'running', 'finishing'].includes(j.status),
      );
      if (!old) break;
      this.jobs.delete(old.id);
    }
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const env = toolEnvironment();
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL('./background-worker.' + extension, import.meta.url))],
      { env, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    let ended!: () => void, ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const job: Job = {
      plan,
      policy: environment.policy,
      id: randomUUID(),
      scope,
      command: String(args.command),
      cwd,
      createdAt: new Date().toISOString(),
      worker,
      status: 'starting',
      exitCode: null,
      output: '',
      total: 0,
      offset: 0,
      done: new Promise<void>((resolve) => {
        ended = resolve;
      }),
      cleanupFailed: false,
      inputs: new Map(),
      ...(ctx.commandJournal ? { journal: ctx.commandJournal } : {}),
    };
    this.jobs.set(job.id, job);
    /**
     * The session learns it started before the process can produce anything.
     *
     * Recorded here rather than after the handshake so the record is the *start*, not "it started and we noticed
     * later": a `command.started` with no `command.settled` is the honest shape of a crash, and a record written
     * after the process is running could not express it.
     */
    job.journal?.started({
      id: job.id,
      sessionId: scope,
      command: job.command,
      cwd,
      createdAt: job.createdAt,
    });
    worker.on('message', (raw: unknown) => {
      const msg = raw as {
        type: string;
        pid: number;
        text: string;
        dropped: number;
        code: number | null;
        stopped: boolean;
        failed: boolean;
        processClosed: boolean;
        id: string;
        error: boolean;
      };
      if (msg.type === 'ready') {
        job.pid = msg.pid;
        job.status = 'running';
        ready();
      }
      if (msg.type === 'output') {
        if (msg.dropped) {
          job.output = '';
          job.offset = job.total + msg.dropped;
        }
        job.total += msg.dropped + msg.text.length;
        job.output = (job.output + msg.text).slice(-65536);
        job.offset = job.total - job.output.length;
      }
      if (msg.type === 'exit') {
        job.finalStatus = msg.failed ? 'failed' : msg.stopped ? 'cancelled' : 'completed';
        job.status = 'finishing';
        job.processClosed = msg.processClosed === true;
        job.exitCode = msg.code;
        job.finishedAt = new Date().toISOString();
      }
      if (msg.type === 'cleanup-error') job.cleanupFailed = true;
      if (msg.type === 'input-result') {
        const pending = job.inputs.get(msg.id);
        job.inputs.delete(msg.id);
        if (msg.error) pending?.reject(new Error('Command stdin write failed'));
        else pending?.resolve();
      }
    });
    worker.on('error', () => {
      job.status = 'failed';
      job.finishedAt ??= new Date().toISOString();
      ready();
    });
    worker.on('close', () => {
      job.finishedAt ??= new Date().toISOString();
      for (const pending of job.inputs.values())
        pending.reject(new Error('Command exited before stdin acknowledgement'));
      job.inputs.clear();
      ready();
      job.status = 'finishing';
      // A worker's serialized plan does not own permission leases. Only this Host can release them.
      // If it vanished without confirming termination, preserve resources and report uncertainty.
      void this.cleanup(job)
        .then(() => {
          job.status = job.cleanupFailed ? 'failed' : (job.finalStatus ?? 'failed');
          try {
            this.settle(job);
          } finally {
            ended();
          }
        })
        .catch((error: unknown) => {
          /**
           * The outcome is recorded in the session log, and that write is the one step here that can refuse.
           *
           * Nobody awaits this chain — the worker's exit is the caller — so a rejection escaping it is an
           * unhandled rejection, which ends the Host. A failed journal write is worth a diagnostic line and
           * nothing more: the job's own state is already published, and `ended()` has already released it.
           */
          process.stderr.write(
            `background command ${job.id} could not record its outcome: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        });
    });
    markSandboxStarted(plan);
    worker.send(
      {
        type: 'start',
        plan,
        command: String(args.command),
        cwd,
        timeout: Number(args.timeout_ms ?? 300000),
      },
      () => {},
    );
    try {
      await wait(started, 10000, ctx.signal);
      if (!job.pid) throw new Error('Background command failed to start');
      return this.snapshot(job);
    } catch (error) {
      await this.stop(job);
      throw error;
    }
  }
  private cleanup(job: Job): Promise<void> {
    return (job.cleanup ??= (async () => {
      if (!job.processClosed || job.cleanupFailed) {
        job.cleanupFailed = true;
        return;
      }
      try {
        await cleanupSandbox(job.plan);
      } catch {
        job.cleanupFailed = true;
      }
    })());
  }
  private async stop(job: Job): Promise<void> {
    let stopError: unknown;
    try {
      if (['starting', 'running'].includes(job.status)) {
        if (job.worker.connected) job.worker.send({ type: 'stop' }, () => {});
        await wait(job.done, 8000);
        if (['starting', 'running'].includes(job.status)) {
          if (job.worker.pid) await killTree(job.worker.pid);
          await wait(job.done, 1000);
          job.cleanupFailed = true;
        }
      } else await wait(job.done, 8000);
    } catch (error) {
      job.cleanupFailed = true;
      stopError = error;
    } finally {
      await this.cleanup(job);
    }
    if (job.cleanupFailed) {
      this.settle(job);
      const error = new Error('Background command cleanup failed; processes may still be running', {
        cause: stopError,
      });
      error.name = 'ToolCleanupError';
      throw error;
    }
  }
  async close(scope?: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.jobs.values()]
        .filter((j) => scope === undefined || j.scope === scope)
        .map((j) => this.stop(j)),
    );
    if (results.some((r) => r.status === 'rejected')) {
      const error = new Error('Background command cleanup failed');
      error.name = 'ToolCleanupError';
      throw error;
    }
  }
  tools(scope: string): Tool[] {
    const id = { type: 'string', minLength: 1, maxLength: 128 };
    const make = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      action: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>,
      permission?: 'command',
    ): Tool => ({
      name,
      description,
      permission,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      execute: async (args, ctx) => ({
        isError: false,
        content: JSON.stringify(await action(args, ctx)),
      }),
    });
    return [
      make(
        'start_command',
        'Start an approved command as a background job, only for something that keeps running or that you must interact with while it runs (a dev server, a watcher, a long build you poll). For a command that simply finishes, use run_command: it returns the output in one step, where a job costs another call to job_output. Returns a job ID; read output with job_output and stop it with job_kill. Do not self-daemonize or detach children; they cannot be tracked. Jobs survive normal turns but end on cancellation, session deletion or Host exit. stdin is a pipe, not a terminal.',
        {
          command: { type: 'string', minLength: 1, maxLength: 16000 },
          cwd: { type: 'string', minLength: 1, maxLength: 4096 },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 3600000 },
        },
        ['command'],
        (args, ctx) => this.start(args, ctx, scope),
        'command',
      ),
      make(
        'write_command',
        'Send approved input to a managed command stdin; eof closes stdin.',
        { id, input: { type: 'string', maxLength: 16000 }, eof: { type: 'boolean' } },
        ['id', 'input'],
        async (args, ctx) => {
          const job = this.get(String(args.id), scope);
          ctx.signal.throwIfAborted();
          const config = resolveSandboxConfig();
          const current = snapshotExecutionPolicy(
            ctx.executionPolicy ?? executionPolicy(config.mode, config),
          );
          if (JSON.stringify(current) !== JSON.stringify(job.policy))
            throw new Error(
              'Background command creation policy differs from this call; stop it and start a new command',
            );
          if (job.status !== 'running' || !job.worker.connected)
            throw new Error('Command is not running');
          const requestId = randomUUID();
          let acknowledged = false;
          const response = new Promise<void>((resolve, reject) =>
            job.inputs.set(requestId, {
              resolve: () => {
                acknowledged = true;
                resolve();
              },
              reject,
            }),
          );
          job.worker.send(
            { type: 'input', id: requestId, input: String(args.input), eof: args.eof === true },
            (error) => {
              if (error) job.inputs.get(requestId)?.reject(error);
            },
          );
          try {
            await wait(response, 5000, ctx.signal);
            if (!acknowledged) throw new Error('Command stdin acknowledgement timed out');
          } finally {
            job.inputs.delete(requestId);
          }
          return { id: job.id, accepted: true };
        },
        'command',
      ),
    ];
  }
}
