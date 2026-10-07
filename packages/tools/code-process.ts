import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localExecutionEnvironment } from './execution-environment.ts';
import { executionPolicy } from './execution-policy.ts';
import { resolveSandboxConfig } from './sandbox-provider.ts';
import type { ToolContext } from '../protocol/index.ts';
import type { CodeWorkerData, CallRequest, WorkerMessage } from './code-worker.ts';

const FRAME_BYTES = 1_048_576;
const TOTAL_BYTES = 8_388_608;
const CALL_LIMIT = 2048;
type Message = CallRequest | WorkerMessage;

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
  const channel = new EventEmitter();
  channel.on('error', () => {});
  let stopping: Promise<void> | undefined;
  let buffer = Buffer.alloc(0);
  let total = 0;
  let receivedResult = false;
  let stderr = '';
  const ids = new Set<number>();
  const names = new Set(data.names);
  const terminate = () =>
    (stopping ??= (async () => {
      await running.stop();
      await running.closed;
    })());
  const fail = (error: unknown) => {
    channel.emit('error', error instanceof Error ? error : new Error(String(error)));
    void terminate().catch(() => {});
  };
  running.child.stdout!.on('data', (chunk: Buffer) => {
    if (stopping) return;
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
        const message = validateCodeMessage(JSON.parse(frame.toString('utf8')), names, ids);
        if (message.type !== 'call') receivedResult = true;
        channel.emit('message', message);
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
  const postMessage = (message: unknown) => {
    if (stopping) return;
    const payload = JSON.stringify(message) + '\n';
    if (
      Buffer.byteLength(payload) > FRAME_BYTES ||
      running.child.stdin!.writableLength + Buffer.byteLength(payload) > 4 * FRAME_BYTES
    )
      return fail(new Error('Program RPC input limit exceeded'));
    running.child.stdin!.write(payload, (error) => {
      if (error && !stopping) fail(error);
    });
  };
  running.child.stdin!.on('error', (error) => {
    if (!stopping) fail(error);
  });
  postMessage({ type: 'start', data });
  return Object.assign(channel, { postMessage, terminate, pid: running.child.pid });
}
