import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import type { ModelRequest, ModelResponse, ToolCall } from '../packages/protocol/index.ts';

export async function runDelegationCase(options: {
  variant: 'blocking' | 'overlap';
  childDelayMs?: number;
  parentDelayMs?: number;
  childFailure?: boolean;
  cancelOnRead?: AbortController;
  signal?: AbortSignal;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-perf-delegate-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = new ToolRegistry();
  const session = store.create(root);
  const intervals: { lane: string; start: number; end: number }[] = [];
  let parentRound = 0,
    requests = 0,
    collectCalls = 0,
    parentReadVerified = false;
  let parentFinishedWithReport = false;
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    options.cancelOnRead?.signal ?? new AbortController().signal,
    AbortSignal.timeout(15_000),
  ]);
  const started = performance.now();
  await writeFile(path.join(root, 'parent.txt'), 'PARENT_MARKER');
  await writeFile(path.join(root, 'child.txt'), 'CHILD_MARKER');
  tools.register({
    name: 'read_file',
    description: 'Read one synthetic fixture with a controlled cancellable delay.',
    inputSchema: {
      type: 'object',
      properties: { path: { enum: ['parent.txt', 'child.txt'] } },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const lane = args.path === 'child.txt' ? 'child' : 'parent';
      const span = { lane, start: performance.now() - started, end: 0 };
      intervals.push(span);
      if (options.cancelOnRead)
        options.cancelOnRead.abort(new Error('Synthetic benchmark cancellation'));
      try {
        await delay(
          lane === 'child' ? (options.childDelayMs ?? 200) : (options.parentDelayMs ?? 120),
          undefined,
          { signal: context.signal },
        );
        const text = await readFile(path.join(root, String(args.path)), 'utf8');
        if (lane === 'parent') parentReadVerified = text === 'PARENT_MARKER';
        return { isError: false, content: text };
      } finally {
        span.end = performance.now() - started;
      }
    },
  });
  function answer(request: ModelRequest, calls: ToolCall[], text = ''): ModelResponse {
    if (text) request.onText(text);
    return {
      text,
      toolCalls: calls,
      finishReason: calls.length ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: Math.ceil(JSON.stringify([request.tools, request.messages]).length / 4),
        outputTokens: Math.ceil(JSON.stringify([text, calls]).length / 4),
      },
    };
  }
  try {
    const result = await new Agent({
      store,
      tools,
      approve: async () => false,
      maxModelRetries: 0,
      subagents: { enabled: true, timeoutMs: 5000, maxPerRun: 1, collectWaitMs: 1000 },
      provider: {
        async complete(request) {
          if (++requests > 12) throw new Error('Delegation request limit exceeded');
          if (request.system.includes('You are a sub-agent delegated by a parent agent')) {
            if (options.childFailure)
              throw new RunFailure('transport', 'Synthetic child provider failure');
            if (request.messages.at(-1)?.role !== 'tool')
              return answer(request, [
                { id: 'child-read', name: 'read_file', arguments: { path: 'child.txt' } },
              ]);
            return answer(request, [], 'CHILD_MARKER');
          }
          const round = parentRound++;
          if (round === 0)
            return answer(request, [
              {
                id: 'delegate',
                name: 'delegate_task',
                arguments: {
                  tasks: [
                    { objective: 'Read child.txt and return its exact marker.', role: 'explore' },
                  ],
                  wait: options.variant === 'blocking',
                },
              },
            ]);
          if (round === 1)
            return answer(request, [
              { id: 'parent-read', name: 'read_file', arguments: { path: 'parent.txt' } },
            ]);
          const reports = request.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.content)
            .join('\n');
          if (
            options.variant === 'overlap' &&
            (round === 2 || (round === 3 && !reports.includes('CHILD_MARKER')))
          ) {
            collectCalls++;
            // One non-blocking check, followed by at most one bounded wait; never a polling loop.
            return answer(request, [
              {
                id: `collect-${round}`,
                name: 'collect_subagents',
                arguments: { waitMs: round === 2 ? 0 : 1000 },
              },
            ]);
          }
          parentFinishedWithReport = reports.includes('CHILD_MARKER');
          return answer(
            request,
            [],
            parentFinishedWithReport ? 'PARENT_MARKER CHILD_MARKER' : 'Child did not complete.',
          );
        },
      },
    }).run({
      sessionId: session.id,
      prompt:
        'Read an independent parent fixture while a child reads its own fixture, then collect its result.',
      signal,
    });
    const children = store.childSessions(session.id);
    const child = result.subagents?.[0];
    const childReportVerified = child?.status === 'completed' && parentFinishedWithReport;
    const sessionsReleased = [session, ...children].every(
      (entry) => store.get(entry.id).activeRun === null,
    );
    const parentSpan = intervals.find((span) => span.lane === 'parent');
    const childSpan = intervals.find((span) => span.lane === 'child');
    const overlapMs =
      parentSpan && childSpan
        ? Math.max(
            0,
            Math.min(parentSpan.end, childSpan.end) - Math.max(parentSpan.start, childSpan.start),
          )
        : 0;
    const verified =
      result.status === 'completed' &&
      parentReadVerified &&
      childReportVerified &&
      sessionsReleased;
    return {
      variant: options.variant,
      status: result.status,
      verified,
      wallMs: performance.now() - started,
      childStatus: child?.status,
      parentReadVerified,
      childReportVerified,
      sessionsReleased,
      collectCalls,
      requests,
      overlapMs,
      intervals,
      usageSource: 'fixture-estimate',
      statistics: result.statistics,
    };
  } finally {
    await tools.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
