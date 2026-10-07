import { mkdtemp, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { quantile } from './performance-cases.ts';
import type { ModelResponse } from '../packages/protocol/index.ts';

type Kind = 'normal' | 'tool-failure' | 'cancel' | 'provider-failure';
interface StressSample {
  kind: Kind;
  status: string;
  checksPassed: boolean;
  wallMs: number;
}
function complete(text: string): ModelResponse {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: Math.ceil(text.length / 4) },
  };
}

export async function runStressCase(options: {
  durationMs: number;
  concurrency?: number;
  outputChars?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onReady?: () => void;
  onProgress?: (data: { elapsedMs: number; runs: number; rssBytes: number }) => void;
}) {
  const concurrency = options.concurrency ?? 4;
  const outputChars = options.outputChars ?? 131072;
  const intervalMs = options.intervalMs ?? 5000;
  if (
    !Number.isSafeInteger(options.durationMs) ||
    options.durationMs < 1 ||
    options.durationMs > 3_600_000
  )
    throw new Error('duration must be 1..3600000 milliseconds');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('concurrency must be 1..32');
  if (!Number.isSafeInteger(outputChars) || outputChars < 1 || outputChars > 1_048_576)
    throw new Error('output must be 1..1048576 characters');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000)
    throw new Error('interval must be 10..60000 milliseconds');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-perf-stress-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  const lanes = Array.from({ length: concurrency }, () => store.create(root));
  const tools = new ToolRegistry();
  const samples: StressSample[] = [];
  const resources: {
    elapsedMs: number;
    rssBytes: number;
    heapBytes: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
  }[] = [];
  const started = performance.now(),
    cpu = process.cpuUsage();
  const shutdown = new AbortController();
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.durationMs + 30_000),
    shutdown.signal,
  ]);
  const pendingRuns = new Set<Promise<unknown>>();
  function track<T>(run: Promise<T>): Promise<T> {
    pendingRuns.add(run);
    void run.then(
      () => pendingRuns.delete(run),
      () => pendingRuns.delete(run),
    );
    return run;
  }
  let active = 0,
    peakConcurrency = 0,
    emittedChars = 0,
    cycle = 0;
  const resource = () => {
    const memory = process.memoryUsage(),
      used = process.cpuUsage(cpu);
    const row = {
      elapsedMs: performance.now() - started,
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      cpuUserMicros: used.user,
      cpuSystemMicros: used.system,
    };
    resources.push(row);
    options.onProgress?.({
      elapsedMs: row.elapsedMs,
      runs: samples.length,
      rssBytes: row.rssBytes,
    });
  };
  async function faultRun(lane: { id: string }, kind: Kind): Promise<StressSample> {
    const owner = new ToolRegistry();
    const cancel = new AbortController();
    let toolFailed = false,
      round = 0;
    owner.register({
      name: 'read_probe',
      description: 'Bounded synthetic stress probe.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, context) {
        if (kind === 'cancel') cancel.abort(new Error('Synthetic tool cancellation'));
        await delay(10, undefined, { signal: context.signal });
        if (kind === 'tool-failure') throw new Error('SYNTHETIC_TOOL_FAILURE');
        return { isError: false, content: 'PROBE_OK' };
      },
    });
    const begin = performance.now();
    peakConcurrency = Math.max(peakConcurrency, ++active);
    try {
      const result = await new Agent({
        store,
        tools: owner,
        approve: async () => false,
        maxModelRetries: 0,
        subagents: { enabled: false },
        onEvent(event) {
          if (
            event.type === 'tool.finished' &&
            event.data.isError &&
            String(event.data.content).includes('SYNTHETIC_TOOL_FAILURE')
          )
            toolFailed = true;
        },
        provider: {
          async complete(request) {
            if (kind === 'provider-failure')
              throw new RunFailure('transport', 'SYNTHETIC_PROVIDER_FAILURE');
            if (++round > 3) throw new Error('Stress run request limit exceeded');
            if (round === 1)
              return {
                ...complete(''),
                finishReason: 'tool_calls',
                toolCalls: [{ id: `probe-${cycle}`, name: 'read_probe', arguments: {} }],
              };
            const text = toolFailed ? 'RECOVERED_FROM_TOOL_ERROR' : 'PROBE_OK';
            request.onText(text);
            return complete(text);
          },
        },
      }).run({
        sessionId: lane.id,
        prompt: 'Execute one synthetic probe and report its actual outcome.',
        signal: AbortSignal.any([signal, cancel.signal]),
      });
      const expected =
        kind === 'cancel'
          ? result.status === 'cancelled'
          : kind === 'provider-failure'
            ? result.status === 'failed'
            : result.status === 'completed' &&
              result.text ===
                (kind === 'tool-failure' ? 'RECOVERED_FROM_TOOL_ERROR' : 'PROBE_OK') &&
              (kind !== 'tool-failure' || toolFailed);
      return {
        kind,
        status: result.status,
        checksPassed: expected && store.get(lane.id).activeRun === null,
        wallMs: performance.now() - begin,
      };
    } finally {
      active--;
      await owner.close();
    }
  }
  let storeClosed = false;
  try {
    resource();
    const longRun = track(
      new Agent({
        store,
        tools,
        approve: async () => false,
        subagents: { enabled: false },
        maxModelRetries: 0,
        maxOutputTokens: Math.ceil(outputChars / 4) + 1024,
        requestTimeoutMs: options.durationMs + 10_000,
        provider: {
          async complete(request) {
            peakConcurrency = Math.max(peakConcurrency, ++active);
            try {
              const chunks = Math.ceil(outputChars / 2048);
              for (let i = 0; i < chunks; i++) {
                const target = started + (options.durationMs * (i + 1)) / chunks;
                await delay(Math.max(0, target - performance.now()), undefined, {
                  signal: request.signal,
                });
                const text = 'X'.repeat(Math.min(2048, outputChars - emittedChars));
                request.onText(text);
                emittedChars += text.length;
              }
              return complete('X'.repeat(outputChars));
            } finally {
              active--;
            }
          },
        },
      }).run({ sessionId: session.id, prompt: 'Stream a bounded synthetic long answer.', signal }),
    );
    options.onReady?.();
    while (performance.now() - started < options.durationMs && !signal.aborted) {
      const kinds: Kind[] = ['normal', 'tool-failure', 'cancel', 'provider-failure'];
      samples.push(
        ...(await Promise.all(
          lanes.map((lane, index) => track(faultRun(lane, kinds[(cycle + index) % kinds.length]!))),
        )),
      );
      cycle++;
      resource();
      const remaining = options.durationMs - (performance.now() - started);
      if (remaining > 0)
        await delay(Math.min(intervalMs, remaining), undefined, { signal }).catch(() => {});
    }
    const result = await longRun;
    const actualDurationMs = performance.now() - started;
    resource();
    const sessionsReleased = [session, ...lanes].every(
      (entry) => store.get(entry.id).activeRun === null,
    );
    const statistics = store.statistics(session.id);
    store.close();
    storeClosed = true;
    const reopened = new SessionStore(db);
    let reloadedOutputChars = 0,
      reloadMatches = false;
    try {
      for (const message of reopened.messages(session.id))
        if (message.role === 'assistant') reloadedOutputChars += message.content.length;
      reloadMatches =
        JSON.stringify(reopened.statistics(session.id)) === JSON.stringify(statistics);
    } finally {
      reopened.close();
    }
    const databaseBytes = (await stat(db)).size;
    const checksPassed =
      !signal.aborted &&
      result.status === 'completed' &&
      emittedChars === outputChars &&
      result.text.length === outputChars &&
      reloadedOutputChars === outputChars &&
      reloadMatches &&
      sessionsReleased &&
      samples.every((sample) => sample.checksPassed);
    return {
      checksPassed,
      cancelled: signal.aborted,
      requestedDurationMs: options.durationMs,
      actualDurationMs,
      hourVerified: checksPassed && actualDurationMs >= 3_600_000,
      concurrency,
      peakConcurrency,
      outputChars: emittedChars,
      reloadedOutputChars,
      reloadMatches,
      sessionsReleased,
      resources,
      samples,
      databaseBytes,
      p50: quantile(
        samples.map((sample) => sample.wallMs),
        0.5,
      ),
      p95: quantile(
        samples.map((sample) => sample.wallMs),
        0.95,
      ),
      usageSource: 'fixture-estimate',
      scope: 'local-kernel-stream-and-session-stress',
    };
  } finally {
    // A callback or one lane can reject while siblings still own the database.
    shutdown.abort(new Error('Stress workload is shutting down'));
    await Promise.allSettled([...pendingRuns]);
    await tools.close();
    if (!storeClosed) store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
