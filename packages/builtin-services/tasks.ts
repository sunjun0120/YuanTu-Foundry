// packages/builtin-services/tasks.ts
/**
 * Asynchronous analysis tasks, as `analysis` jobs.
 *
 * The backend answers a slow tool with a task id; this producer follows it through the backend's status, result and
 * cancel tools, so a model uses `job_list`, `job_output` and `job_kill` exactly as it does for a command. Records are
 * kept in the workspace's internal directory, so a task started before a Host restart can still be read afterwards.
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JobProducer, JobSnapshot } from '../protocol/jobs.ts';
import { UnknownJobError } from '../protocol/jobs.ts';
import { atomicWriteFile } from '../platform/write-all.ts';
import type { AnalysisClient } from './client.ts';
import type { BuiltinServiceManifest } from './manifest.ts';
import { formatResult, type TaskStarter } from './remote-tools.ts';

interface TaskRecord {
  id: string;
  scope: string;
  taskId: string;
  tool: string;
  label: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  output: string;
  /** Set once this record's own output cap dropped something, and reported on every snapshot afterwards. */
  truncated?: boolean;
}

interface AnalysisTasksDeps {
  file: string;
  manifest: BuiltinServiceManifest;
  client: Pick<AnalysisClient, 'callTool'>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const SETTLED = new Set(['completed', 'failed', 'cancelled']);
const MAX_RECORDS = 200;
const KILL_TIMEOUT_MS = 30_000;
/**
 * How much output one task record keeps.
 *
 * A record is streamed back through `job_output` and the whole file is rewritten on every poll, so this bounds both
 * what one result can cost the workspace file and how much a single poll has to serialise.
 */
export const MAX_RECORD_OUTPUT = 1_000_000;
const TRUNCATION_NOTE = '\n[the rest of this task’s output was dropped]\n';

export class AnalysisTasks implements TaskStarter {
  private records: TaskRecord[];
  private saving: Promise<void> = Promise.resolve();
  /** The newest record set waiting to be written; the loop below always writes the latest one. */
  private queued: Buffer | undefined;
  private writing = false;
  /** Per record, the poll already in flight, so two `job_output` calls do not ask the backend twice. */
  private readonly polling = new Map<string, Promise<void>>();
  private readonly cancelling = new Map<string, Promise<void>>();
  private readonly deps: AnalysisTasksDeps;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(deps: AnalysisTasksDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    try {
      const parsed = JSON.parse(readFileSync(deps.file, 'utf8'));
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.records = [];
    }
  }
  start(input: { scope: string; taskId: string; tool: string; label: string }): { id: string } {
    const id = `analysis-${input.taskId}`;
    this.records = this.records.filter((record) => record.id !== id);
    this.records.push({
      ...input,
      id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      output: '',
    });
    // Oldest settled tasks go first; a task still running is never forgotten to make room.
    while (this.records.length > MAX_RECORDS) {
      const index = this.records.findIndex((record) => SETTLED.has(record.status));
      if (index < 0) break;
      this.records.splice(index, 1);
    }
    this.save();
    return { id };
  }
  /** Resolves once every record change so far is on disk. */
  flush(): Promise<void> {
    return this.saving;
  }
  /**
   * Writes the newest record set, coalescing bursts.
   *
   * A task that reports progress every second used to serialise and rewrite the whole file on every poll. Here one
   * write is in flight at a time and it always picks up the latest snapshot, so a burst costs one rewrite instead of
   * one per poll, and `flush()` still waits for the newest one.
   */
  private save(): void {
    this.queued = Buffer.from(JSON.stringify(this.records));
    if (this.writing) return;
    this.writing = true;
    this.saving = (async () => {
      try {
        while (this.queued) {
          const body = this.queued;
          this.queued = undefined;
          await mkdir(path.dirname(this.deps.file), { recursive: true });
          await atomicWriteFile(this.deps.file, body);
        }
      } finally {
        this.writing = false;
      }
    })();
    // Preserve the rejection for flush while preventing an unhandled promise rejection.
    void this.saving.catch(() => undefined);
  }
  private find(id: string, scope: string): TaskRecord {
    const record = this.records.find((entry) => entry.id === id && entry.scope === scope);
    if (!record) throw new UnknownJobError(id);
    return record;
  }
  private call(name: string, record: TaskRecord, signal?: AbortSignal): Promise<CallToolResult> {
    return this.deps.client.callTool(
      name,
      { task_id: record.taskId },
      signal ?? AbortSignal.timeout(this.deps.manifest.callTimeoutMs),
    );
  }
  /** Appends to one record without letting it grow past `MAX_RECORD_OUTPUT`; the cut is reported as `truncated`. */
  private append(record: TaskRecord, text: string): void {
    if (record.output.length >= MAX_RECORD_OUTPUT) {
      record.truncated = true;
      return;
    }
    record.output += text;
    if (record.output.length > MAX_RECORD_OUTPUT) {
      record.output = `${record.output.slice(0, MAX_RECORD_OUTPUT)}${TRUNCATION_NOTE}`;
      record.truncated = true;
    }
  }
  /**
   * Polls once, or joins the poll already in flight for this record.
   *
   * `job_output` is registered as concurrency safe, so two sibling calls can name the same task. Without this both
   * would send `task_status` (and then `task_result`) and append the same answer twice.
   */
  private refresh(record: TaskRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let work = this.polling.get(record.id);
    if (!work) {
      work = this.poll(record, AbortSignal.timeout(this.deps.manifest.callTimeoutMs)).finally(
        () => {
          this.polling.delete(record.id);
        },
      );
      this.polling.set(record.id, work);
    }
    return follow(work, signal);
  }
  private async poll(record: TaskRecord, signal?: AbortSignal): Promise<void> {
    const before = {
      status: record.status,
      output: record.output,
      truncated: record.truncated,
      finishedAt: record.finishedAt,
    };
    const reply = await this.call(this.deps.manifest.taskTools.status, record, signal);
    if (SETTLED.has(record.status)) return;
    if (reply.isError) throw new Error('Analysis status is temporarily unavailable');
    const status = (reply.structuredContent ?? {}) as {
      status?: unknown;
      message?: unknown;
      progress?: unknown;
    };
    if (typeof status.status !== 'string' || !STATUSES.has(status.status))
      throw new Error(`Analysis service returned an unknown task status for ${record.taskId}`);
    const line = [
      status.status,
      typeof status.progress === 'number' ? `${status.progress}%` : '',
      typeof status.message === 'string' ? status.message.slice(0, 300) : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (!record.output.endsWith(`${line}\n`)) this.append(record, `${line}\n`);
    if (status.status === 'completed') {
      const result = await this.call(this.deps.manifest.taskTools.result, record, signal);
      if (SETTLED.has(record.status)) return;
      if (result.isError) throw new Error('Analysis result is temporarily unavailable');
      this.append(record, `${formatResult(result, this.deps.manifest.maxResultChars).content}\n`);
    }
    record.status = status.status;
    if (SETTLED.has(record.status)) record.finishedAt = new Date().toISOString();
    this.save();
    try {
      await this.flush();
    } catch (error) {
      if (record.status === status.status) Object.assign(record, before);
      throw error;
    }
  }
  private snapshot(record: TaskRecord, cursor: number): JobSnapshot {
    return {
      id: record.id,
      kind: 'analysis',
      sessionId: record.scope,
      label: record.label,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      output: record.output.slice(cursor),
      nextCursor: record.output.length,
      truncated: record.truncated === true,
      detail: { taskId: record.taskId, tool: record.tool },
    };
  }
  jobProducer(): JobProducer {
    return {
      kind: 'analysis',
      owns: ({ id, scope }) =>
        this.records.some((record) => record.id === id && record.scope === scope),
      list: (scope) =>
        this.records
          .filter((record) => record.scope === scope)
          .map((record) => this.snapshot(record, 0)),
      output: async ({ id, scope, cursor, waitMs, signal }) => {
        const record = this.find(id, scope);
        const deadline = Date.now() + waitMs;
        let pause = 1_000;
        while (!SETTLED.has(record.status)) {
          await this.refresh(record, signal);
          if (SETTLED.has(record.status) || Date.now() + pause > deadline) break;
          await this.sleep(pause, signal);
          pause = Math.min(pause * 2, 10_000);
        }
        return this.snapshot(record, cursor);
      },
      kill: async ({ id, scope, signal }) => {
        const record = this.find(id, scope);
        if (!SETTLED.has(record.status)) {
          signal?.throwIfAborted();
          let pending = this.cancelling.get(record.id);
          if (!pending) {
            // The request is shared, so it runs on its own timeout; each caller's signal only ends its own wait,
            // as with a shared poll. The first caller's signal used to cancel it for every caller.
            pending = (async () => {
              const reply = await this.call(
                this.deps.manifest.taskTools.cancel,
                record,
                AbortSignal.timeout(KILL_TIMEOUT_MS),
              );
              if (reply.isError) throw new Error('Analysis cancellation failed');
              if (!SETTLED.has(record.status)) {
                record.status = 'cancelled';
                record.finishedAt = new Date().toISOString();
                this.append(record, 'cancelled\n');
                this.save();
                await this.flush();
              }
            })();
            this.cancelling.set(record.id, pending);
            void pending.finally(() => this.cancelling.delete(record.id)).catch(() => {});
          }
          await follow(pending, signal);
        }
        return this.snapshot(record, 0);
      },
    };
  }
}

/** Waits for shared work on behalf of one caller: an abort rejects this wait only, never the work. */
function follow(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    work.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const shared = new Map<string, { baseUrl: string; tasks: AnalysisTasks }>();

/**
 * One record set per workspace, shared by every run there.
 *
 * It holds the client it was made with, so it is made again when the service address changes rather than keep
 * asking the old one; one instance per file still means one writer.
 */
export function sharedTasks(
  root: string,
  manifest: BuiltinServiceManifest,
  client: Pick<AnalysisClient, 'callTool'>,
): AnalysisTasks {
  const file = path.join(path.resolve(root), '.yuantu', 'analysis-tasks.json');
  const entry = shared.get(file);
  if (entry?.baseUrl === manifest.baseUrl) return entry.tasks;
  const tasks = new AnalysisTasks({ file, manifest, client });
  shared.set(file, { baseUrl: manifest.baseUrl, tasks });
  return tasks;
}

/**
 * Forgets every record set, with the clients they hold; the next run reads its workspace file again.
 *
 * Called when the clients are closed: a set kept past that would reconnect its closed client on the next poll,
 * outside anything that closes it.
 */
export function forgetSharedTasks(): void {
  shared.clear();
}
