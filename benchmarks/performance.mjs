import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runBatchCase, summarizePairs } from './performance-cases.ts';
import { createProvider, readConfig } from '../packages/providers/index.ts';
import { redactSecrets } from '../packages/core/errors.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const pairs = Number(args.find((arg) => arg.startsWith('--pairs='))?.slice(8) ?? 3);
const requestLimit = Number(
  args.find((arg) => arg.startsWith('--max-requests='))?.slice(15) ?? 180,
);
if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 180)
  throw new Error('max-requests must be 1..180');
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('pairs must be 1..10');
if (args.some((arg) => !/^--(?:live|pairs=\d+|max-requests=\d+|out=.+)$/.test(arg)))
  throw new Error('Unsupported benchmark option');
const directory = path.resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice(6) ?? `.scratch/performance-${Date.now()}`,
);
await mkdir(directory, { recursive: true });
const file = path.join(directory, 'measurements.jsonl');
await writeFile(file, '', { flag: 'wx' });
const emit = async (row) => appendFile(file, redactSecrets(JSON.stringify(row)) + '\n');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const config = live ? readConfig() : undefined;
const backing = config ? createProvider(config) : undefined;
let totalRequests = 0,
  sample;
const provider = backing
  ? {
      async complete(request) {
        if (++totalRequests > requestLimit) throw new Error('Live request ceiling reached');
        const started = performance.now();
        const row = {
          type: 'request',
          pair: sample.pair,
          variant: sample.variant,
          index: totalRequests,
          catalogBytes: Buffer.byteLength(JSON.stringify(request.tools)),
          catalogCount: request.tools.length,
          requestHash: createHash('sha256')
            .update(JSON.stringify([request.system, request.messages, request.tools]))
            .digest('hex'),
        };
        try {
          const result = await backing.complete(request);
          row.usage = result.usage;
          row.finishReason = result.finishReason;
          row.toolCalls = result.toolCalls.map((call) => call.name);
          return result;
        } catch (error) {
          row.error = redactSecrets(String(error?.message ?? error));
          throw error;
        } finally {
          row.elapsedMs = performance.now() - started;
          await emit(row);
        }
      },
    }
  : undefined;
const sourceHashes = {};
for (const name of [
  'benchmarks/performance.mjs',
  'benchmarks/performance-cases.ts',
  'packages/tools/run-code.ts',
])
  sourceHashes[name] = createHash('sha256')
    .update(await readFile(name))
    .digest('hex');
await emit({
  type: 'metadata',
  revision,
  at: new Date().toISOString(),
  live,
  pairs,
  requestLimit,
  sourceHashes,
  model: config?.model,
  protocol: config?.protocol,
  endpoint: config?.baseUrl,
  sandbox: process.env.YUANTU_SANDBOX ?? 'default',
  usageSource: live ? 'provider' : 'fixture-estimate',
});
const rows = [];
for (let pair = 0; pair < pairs; pair++) {
  const variants = ['full-native', 'stage-native', 'stage-ptc'];
  for (const variant of pair % 2 ? variants.reverse() : variants) {
    sample = { pair, variant };
    let row;
    const begin = performance.now();
    try {
      row = {
        type: 'run',
        pair,
        ...(await runBatchCase({
          variant,
          provider,
          modelInfo: config
            ? { model: config.model, protocol: config.protocol ?? 'anthropic' }
            : undefined,
          maxOutputTokens: Math.min(config?.maxOutputTokens ?? 2048, 4096),
        })),
      };
    } catch (error) {
      row = {
        type: 'run',
        pair,
        variant,
        status: 'failed',
        verified: false,
        wallMs: performance.now() - begin,
        error: redactSecrets(String(error?.message ?? error)),
      };
    }
    rows.push(row);
    await emit(row);
    console.log(
      JSON.stringify({
        pair,
        variant,
        status: row.status,
        wallMs: row.wallMs,
        requests: row.requests,
        inputTokens: row.inputTokens,
        error: row.error,
      }),
    );
  }
}
const summary = {
  live,
  revision,
  totalRequests,
  rows: rows.length,
  catalog: summarizePairs(rows, 'full-native', 'stage-native'),
  ptc: summarizePairs(rows, 'stage-native', 'stage-ptc'),
};
await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(
  `Evidence: ${directory}; verified ${rows.filter((row) => row.verified).length}/${rows.length}`,
);
if (rows.some((row) => !row.verified)) process.exitCode = 1;
