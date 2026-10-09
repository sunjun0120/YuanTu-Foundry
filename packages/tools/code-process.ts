import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localExecutionEnvironment } from './execution-environment.ts';
import { executionPolicy } from './execution-policy.ts';
import { resolveSandboxConfig } from './sandbox-provider.ts';
import type { ToolContext } from '../protocol/index.ts';
import type { CodeWorkerData, CallRequest, WorkerMessage } from './code-worker.ts';
import type { ChildProcess } from 'node:child_process';
import { PROGRAM_PROTOCOL, PROGRAM_NODE_MAJOR } from './environment.ts';

const FRAME_BYTES = 1_048_576;
const TOTAL_BYTES = 8_388_608;
const CALL_LIMIT = 2048;
type Message = CallRequest | WorkerMessage;

export function validateCodeReady(value: unknown): void {
  const item = value as Record<string, unknown> | null;
  if (
    !item ||
    Array.isArray(item) ||
    item.type !== 'ready' ||
    item.protocol !== PROGRAM_PROTOCOL ||
    !Number.isSafeInteger(item.nodeMajor) ||
    (item.nodeMajor as number) < PROGRAM_NODE_MAJOR
  )
    throw new Error('Invalid or incompatible program runner handshake');
}

interface ProgramProcess {
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'stderr' | 'pid'>;
  stop(): Promise<void>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Every byte from the program is untrusted, including messages that appear to come from our runner. */
export function validateCodeMessage(
  value: unknown,
  names: ReadonlySet<string>,
  ids: Set<number>,
): Message {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid program RPC message');
  const item = value as Record<string, unknown>;
  if (item.type === 'call') {
    if (
      !Number.isSafeInteger(item.id) ||
      (item.id as number) < 1 ||
      ids.has(item.id as number) ||
      ids.size >= CALL_LIMIT
    )
      throw new Error('Invalid, repeated or excessive program RPC id');
    if (typeof item.name !== 'string' || !names.has(item.name))
      throw new Error('Program RPC tool is outside this run catalog');
    if (!item.args || typeof item.args !== 'object' || Array.isArray(item.args))
      throw new Error('Program RPC arguments must be an object');
    ids.add(item.id as number);
    return value as CallRequest;
  }
  if (item.type !== 'result' && item.type !== 'error')
    throw new Error('Unknown program RPC message');
  if (
    !Array.isArray(item.logs) ||
    item.logs.length > 200 ||
    item.logs.some((line) => typeof line !== 'string') ||
    item.logs.join('').length > 8000
  )
    throw new Error('Program log limit exceeded');
  const answer = item.type === 'result' ? item.value : item.message;
  if (typeof answer !== 'string' || answer.length > 400000)
    throw new Error('Invalid or excessive program result');
  return value as WorkerMessage;
}

export async function startCodeProcess(data: CodeWorkerData, context: ToolContext) {
  context.signal.throwIfAborted();
  const config = resolveSandboxConfig();
  const policy = context.executionPolicy ?? executionPolicy(config.mode, { image: config.image });
  // Container paths need a separately installed runner image. Refuse before any process or tool is started.
  if (policy.mode === 'docker' || policy.mode === 'sbx')
    throw new Error(
      `${policy.mode} does not support the program runner yet; no host fallback is allowed`,
    );
  if (policy.mode !== 'host' && !context.workspaceRoot)
    throw new Error('Restricted programs require a workspace identity');
  const root = context.workspaceRoot ?? process.cwd();
  const runtime = fileURLToPath(new URL('.', import.meta.url));
  const entry = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './code-process-entry.ts' : './code-process-entry.js',
      import.meta.url,
    ),
  );
  const env = await localExecutionEnvironment(root, policy);
  // The permission model is defense in depth, not a malicious-code sandbox. No direct fs write grant.
  const running = await env.processes.start(
    process.execPath,
    [
      '--permission',
      '--allow-worker',
      '--disable-warning=SecurityWarning',
      `--allow-fs-read=${path.join(runtime, 'code-process-entry.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'))}`,
      `--allow-fs-read=${path.join(runtime, 'code-worker.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'))}`,
      `--allow-fs-read=${path.join(runtime, 'environment.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'))}`,
      entry,
    ],
    '.',
    context.signal,
  );
  return connectCodeProcess(data, running, context.signal);
}

/** Shared transport for owned runner processes. This does not choose or relax an execution backend. */
export async function connectCodeProcess(
  data: CodeWorkerData,
  running: ProgramProcess,
  signal: AbortSignal,
) {
  const channel = new EventEmitter();
  channel.on('error', () => {});
  let stopping: Promise<void> | undefined;
  let buffer = Buffer.alloc(0);
  let total = 0;
  let receivedResult = false;
  let stderr = '';
  const ids = new Set<number>();
  const names = new Set(data.names);
  let ready = false;
  let starting = true;
  let scriptSent = false;
  let delivering = false;
  const pending: Message[] = [];
  let deliveryError: Error | undefined;
  let startupError: Error | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Failure can arrive before the await below has installed its handler.
  void handshake.catch(() => {});
  let rejectStartup!: (error: Error) => void;
  const startupFailed = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  void startupFailed.catch(() => {});
  const abort = () => fail(signal.reason ?? new Error('Program cancelled'));
  const terminate = () =>
    (stopping ??= (async () => {
      signal.removeEventListener('abort', abort);
      await running.stop();
      await running.closed;
    })());
  const fail = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (starting) {
      startupError ??= failure;
      rejectReady(failure);
      rejectStartup(failure);
    }
    if (delivering) channel.emit('error', failure);
    else deliveryError ??= failure;
    void terminate().catch(() => {});
  };
  running.child.stdout!.on('data', (chunk: Buffer) => {
    if (stopping) return;
    if (ready && !scriptSent && chunk.length)
      return fail(new Error('Program RPC before script start'));
    total += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    if (total > TOTAL_BYTES || buffer.length > FRAME_BYTES)
      return fail(new Error('Program RPC output limit exceeded'));
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        if (receivedResult) throw new Error('Program RPC continued after its result');
        const value: unknown = JSON.parse(frame.toString('utf8'));
        if (!ready) {
          validateCodeReady(value);
          if (buffer.length) throw new Error('Program RPC before script start');
          ready = true;
          resolveReady();
          continue;
        }
        if (!scriptSent) throw new Error('Program RPC before script start');
        const message = validateCodeMessage(value, names, ids);
        if (message.type !== 'call') receivedResult = true;
        if (delivering) channel.emit('message', message);
        else pending.push(message);
      } catch (error) {
        fail(error);
        break;
      }
    }
  });
  running.child.stderr!.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  void running.closed.then((outcome) => {
    if (!stopping) {
      const unknown = new Error(
        `Program disconnected; its result is unknown (exit ${outcome.code}). ${stderr}`,
      );
      unknown.name = 'ProgramDisconnectedError';
      fail(unknown);
    }
  }, fail);
  const sendMessage = async (message: unknown) => {
    if (stopping) throw new Error('Program is stopping');
    const payload = JSON.stringify(message) + '\n';
    if (
      Buffer.byteLength(payload) > FRAME_BYTES ||
      running.child.stdin!.writableLength + Buffer.byteLength(payload) > 4 * FRAME_BYTES
    )
      throw new Error('Program RPC input limit exceeded');
    await new Promise<void>((resolve, reject) => {
      running.child.stdin!.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  };
  const postMessage = (message: unknown) => {
    if (!stopping) void sendMessage(message).catch(fail);
  };
  running.child.stdin!.on('error', (error) => {
    if (!stopping) fail(error);
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => fail(new Error('Program runner handshake timed out')), 5000);
  try {
    await handshake;
    if (startupError) throw startupError;
    signal.throwIfAborted();
    scriptSent = true;
    await Promise.race([sendMessage({ type: 'start', data }), startupFailed]);
    if (startupError) throw startupError;
    signal.throwIfAborted();
  } catch (error) {
    try {
      await terminate();
    } catch (cleanup) {
      const failure = new AggregateError([error, cleanup], 'Program startup and cleanup failed');
      failure.name = 'ToolCleanupError';
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  starting = false;
  // The caller subscribes after awaiting this function. Retain early replies/errors until then.
  setImmediate(() => {
    delivering = true;
    if (deliveryError) channel.emit('error', deliveryError);
    else
      for (const message of pending) {
        if (stopping) break;
        channel.emit('message', message);
      }
    pending.length = 0;
  });
  return Object.assign(channel, { postMessage, terminate, pid: running.child.pid });
}
