import { readFile } from 'node:fs/promises';
import { summarizePairs, quantile } from './performance-cases.ts';

if (process.argv.length !== 3)
  throw new Error('Usage: node benchmarks/analyze-performance.mjs measurements.jsonl');
const records = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const rows = records.filter((row) => row.type === 'run');
const requests = records.filter((row) => row.type === 'request');
const metadata = records.filter((row) => row.type === 'metadata');
if (metadata.length !== 1) throw new Error('Expected exactly one experiment metadata record');
const metrics = {};
for (const variant of ['full-native', 'stage-native', 'stage-ptc']) {
  const group = rows.filter((row) => row.variant === variant);
  const success = group.filter((row) => row.verified);
  const fields = {};
  for (const key of ['wallMs', 'requests', 'inputTokens', 'outputTokens']) {
    fields[key] = {
      p50: quantile(
        success.map((row) => row[key]),
        0.5,
      ),
      p95: quantile(
        success.map((row) => row[key]),
        0.95,
      ),
    };
  }
  metrics[variant] = {
    samples: group.length,
    failures: group.filter((row) => !row.verified).length,
    fields,
    actualProviderCalls: requests.filter((row) => row.variant === variant).length,
    providerErrors: requests.filter((row) => row.variant === variant && row.error).length,
  };
}
const output = {
  metadata: metadata[0],
  actualProviderCalls: requests.length,
  unfinishedSamples: [
    ...new Set(requests.map((row) => JSON.stringify([row.pair, row.variant]))),
  ].filter((key) => !rows.some((row) => JSON.stringify([row.pair, row.variant]) === key)),
  metrics,
  catalog: summarizePairs(rows, 'full-native', 'stage-native'),
  ptc: summarizePairs(rows, 'stage-native', 'stage-ptc'),
};
console.log(JSON.stringify(output, null, 2));
