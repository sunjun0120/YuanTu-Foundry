import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Agent } from '../packages/core/agent.ts';
import { redactSecrets } from '../packages/core/errors.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolCall,
} from '../packages/protocol/index.ts';

export type BatchVariant = 'full-native' | 'stage-native' | 'stage-ptc';
export interface StageSample {
  stage: string;
  status: string;
  wallMs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  catalogBytes: number[];
  catalogHashes: string[];
  rebuiltUsageMatches: boolean;
  error?: string;
}
export interface PairSample {
  pair: number;
  variant: string;
  verified: boolean;
  wallMs: number;
}
const FILES = Array.from({ length: 6 }, (_, i) => `module-${i}.cjs`);
const BAD = 'module.exports = (a, b) => a - b;\n';
const GOOD = 'module.exports = (a, b) => a + b;\n';
const CHECK = 'node fixture-check.cjs';
const MARKER = 'SYNTHETIC_BATCH_PASS';
const ALLOW = {
  inspect: ['read_file', 'list_files', 'search_files', 'run_code'],
  repair: ['read_file', 'edit_file', 'batch_edit', 'run_code'],
  validate: ['read_file', 'run_command', 'run_code'],
} as const;
type BatchStage = keyof typeof ALLOW;

function response(request: ModelRequest, calls: ToolCall[], text = ''): ModelResponse {
  if (text) request.onText(text);
  return {
    text,
    toolCalls: calls,
    finishReason: calls.length ? 'tool_calls' : 'stop',
    // Deterministic local estimates, explicitly labelled in samples. Live adapters supply real usage.
    usage: {
      inputTokens: Math.ceil(
        JSON.stringify([request.system, request.tools, request.messages]).length / 4,
      ),
      outputTokens: Math.ceil(JSON.stringify([text, calls]).length / 4),
    },
  };
}

function batchProvider(stage: BatchStage, variant: BatchVariant): Provider {
  let round = 0;
  return {
    async complete(request) {
      if (round++) return response(request, [], 'Phase complete.');
      const calls: ToolCall[] =
        stage === 'inspect'
          ? FILES.map((file, i) => ({
              id: `read-${i}`,
              name: 'read_file',
              arguments: { path: file },
            }))
          : stage === 'repair'
            ? FILES.map((file, i) => ({
                id: `edit-${i}`,
                name: 'edit_file',
                arguments: { path: file, old_text: BAD, new_text: GOOD },
              }))
            : [{ id: 'check', name: 'run_command', arguments: { command: CHECK } }];
      if (variant !== 'stage-ptc') return response(request, calls);
      // Run the same calls through the real PTC process and approval pipeline.
      const names = calls.map((call) => `r${call.id.replaceAll('-', '_')}`);
      const code =
        calls
          .map(
            (call, i) =>
              `const ${names[i]} = await tools.${call.name}(${JSON.stringify(call.arguments)});`,
          )
          .join('\n') +
        '\nreturn [' +
        names.join(',') +
        '];';
      return response(request, [{ id: `ptc-${stage}`, name: 'run_code', arguments: { code } }]);
    },
  };
}

export async function runBatchCase(options: {
  variant: BatchVariant;
  provider?: Provider;
  allowWrites?: boolean;
  signal?: AbortSignal;
  modelInfo?: { model: string; protocol: string };
  timeoutMs?: number;
  maxOutputTokens?: number;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-perf-batch-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  const session = store.create(root);
  const owner = createTools(root);
  const stages: StageSample[] = [];
  const toolErrors: string[] = [];
  let deniedApprovals = 0,
    commandVerified = false,
    filesVerified = 0;
  const started = performance.now();
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.timeoutMs ?? 180_000),
  ]);
  try {
    await Promise.all(FILES.map((file) => writeFile(path.join(root, file), BAD)));
    await writeFile(
      path.join(root, 'fixture-check.cjs'),
      `const assert = require('node:assert/strict'); for(let i=0;i<6;i++) { const sum=require('./module-'+i+'.cjs'); assert.equal(sum(2,3),5); assert.equal(sum(-4,7),3); } console.log('${MARKER}');\n`,
    );
    for (const stage of ['inspect', 'repair', 'validate'] as const) {
      if (signal.aborted) break;
      const tools =
        options.variant === 'full-native' ? owner : owner.forRun({ allow: ALLOW[stage] });
      tools.toolMode = options.variant === 'stage-ptc' ? 'ptc' : 'native';
      const before = store.statistics(session.id);
      const catalogBytes: number[] = [],
        catalogHashes: string[] = [];
      let requests = 0;
      const calls = new Map<string, ToolCall>();
      const backing = options.provider ?? batchProvider(stage, options.variant);
      const agent = new Agent({
        store,
        tools,
        ownsToolResources: false,
        provider: {
          async complete(request) {
            if (++requests > 8) throw new Error('Phase request limit exceeded');
            const wire = JSON.stringify(request.tools);
            catalogBytes.push(Buffer.byteLength(wire));
            catalogHashes.push(createHash('sha256').update(wire).digest('hex'));
            return backing.complete({
              ...request,
              signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
            });
          },
        },
        modelInfo: options.modelInfo,
        maxOutputTokens: options.maxOutputTokens ?? 2048,
        maxModelRetries: 0,
        requestTimeoutMs: 90_000,
        subagents: { enabled: false },
        approve: async (approval) => {
          const call = approval.toolCall;
          const permitted =
            options.allowWrites !== false &&
            ((call.name === 'edit_file' && FILES.includes(String(call.arguments.path))) ||
              (call.name === 'batch_edit' &&
                Array.isArray(call.arguments.edits) &&
                call.arguments.edits.every(
                  (edit: unknown) =>
                    Boolean(edit) &&
                    typeof edit === 'object' &&
                    FILES.includes(String((edit as { path?: unknown }).path)),
                )) ||
              (call.name === 'run_command' && call.arguments.command === CHECK) ||
              call.name === 'run_code');
          if (!permitted) deniedApprovals++;
          return permitted;
        },
        onEvent(event) {
          if (event.type === 'tool.started') {
            const call = event.data.call as ToolCall;
            calls.set(call.id, call);
          }
          if (event.type !== 'tool.finished') return;
          if (event.data.isError) {
            const error = redactSecrets(String(event.data.content ?? '')).slice(0, 1000);
            toolErrors.push(error);
            if (process.env.PERF_DEBUG === '1') console.error(error);
            return;
          }
          const call = calls.get(String(event.data.callId));
          const content = String(event.data.content ?? '');
          if (call?.name === 'run_command' && call.arguments.command === CHECK) {
            try {
              const output = JSON.parse(content);
              commandVerified ||= output.exitCode === 0 && String(output.stdout).includes(MARKER);
            } catch {
              /* Invalid output never counts as validation. */
            }
          }
        },
      });
      const begin = performance.now();
      try {
        const purpose =
          stage === 'inspect'
            ? `Read all six files ${FILES.join(', ')} and identify the subtraction bug. Do not edit yet.`
            : stage === 'repair'
              ? 'Fix all six inspected module-N.cjs files so their exports add a and b. Preserve all other bytes. Do not run validation yet.'
              : `Validate all six modules by running exactly ${CHECK}. Only claim success after the real command returns exitCode 0 and ${MARKER}.`;
        const batching =
          options.variant === 'stage-ptc'
            ? ' Use run_code to batch this phase. Return all actual inner tool results, including the command exit code and stdout.'
            : '';
        const result = await agent.run({
          sessionId: session.id,
          signal,
          prompt: `${purpose}${batching} Work only with these synthetic fixture files; do not delegate, create goals, or commit.`,
        });
        const rebuilt = store.statistics(session.id);
        // The durable inner receipt is written by the kernel, never by model-authored program text.
        for (const event of store.events(session.id)) {
          if (
            event.type !== 'program.call.settled' ||
            event.data.name !== 'run_command' ||
            event.data.state !== 'known' ||
            event.data.isError
          )
            continue;
          try {
            const output = JSON.parse(String(event.data.content));
            commandVerified ||= output.exitCode === 0 && String(output.stdout).includes(MARKER);
          } catch {
            /* A malformed or missing receipt never counts as validation. */
          }
        }
        const statistics = result.statistics;
        stages.push({
          stage,
          status: result.status,
          wallMs: performance.now() - begin,
          requests,
          inputTokens: statistics?.inputTokens ?? 0,
          outputTokens: statistics?.outputTokens ?? 0,
          catalogBytes,
          catalogHashes,
          rebuiltUsageMatches:
            Boolean(statistics) &&
            rebuilt.inputTokens - before.inputTokens === statistics?.inputTokens &&
            rebuilt.outputTokens - before.outputTokens === statistics?.outputTokens,
          ...(result.error ? { error: redactSecrets(result.error) } : {}),
        });
        if (result.status !== 'completed') break;
      } finally {
        /* All phases share one owner's read observations and resource lifetime. */
      }
    }
    for (const file of FILES)
      if ((await readFile(path.join(root, file), 'utf8')) === GOOD) filesVerified++;
    const verified =
      stages.length === 3 &&
      stages.every((stage) => stage.status === 'completed' && stage.rebuiltUsageMatches) &&
      filesVerified === FILES.length &&
      commandVerified;
    return {
      variant: options.variant,
      status: verified ? 'completed' : signal.aborted ? 'cancelled' : 'failed',
      verified,
      filesVerified,
      commandVerified,
      deniedApprovals,
      toolErrors,
      stages,
      wallMs: performance.now() - started,
      requests: stages.reduce((n, row) => n + row.requests, 0),
      inputTokens: stages.reduce((n, row) => n + row.inputTokens, 0),
      outputTokens: stages.reduce((n, row) => n + row.outputTokens, 0),
      usageSource: options.provider ? 'provider' : 'fixture-estimate',
    };
  } finally {
    await owner.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export function quantile(values: readonly number[], q: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q,
    low = Math.floor(at),
    high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

export function summarizePairs(allRows: readonly PairSample[], a: string, b: string) {
  const rows = allRows.filter((row) => row.variant === a || row.variant === b);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.pair, row.variant]);
    if (seen.has(key)) throw new Error('Duplicate pair variant');
    seen.add(key);
  }
  const deltas: number[] = [];
  for (const pair of new Set(rows.map((row) => row.pair))) {
    const left = rows.find((row) => row.pair === pair && row.variant === a);
    const right = rows.find((row) => row.pair === pair && row.variant === b);
    if (left?.verified && right?.verified) deltas.push(right.wallMs - left.wallMs);
  }
  const variants: Record<
    string,
    { count: number; failures: number; p50: number | null; p95: number | null }
  > = {};
  for (const variant of [a, b]) {
    const samples = rows.filter((row) => row.variant === variant);
    variants[variant] = {
      count: samples.length,
      failures: samples.filter((row) => !row.verified).length,
      p50: quantile(
        samples.filter((row) => row.verified).map((row) => row.wallMs),
        0.5,
      ),
      p95: quantile(
        samples.filter((row) => row.verified).map((row) => row.wallMs),
        0.95,
      ),
    };
  }
  return {
    samples: rows.length,
    failures: rows.filter((row) => !row.verified).length,
    matchedPairs: deltas.length,
    deltas,
    deltaP50: quantile(deltas, 0.5),
    deltaP95: quantile(deltas, 0.95),
    variants,
  };
}
