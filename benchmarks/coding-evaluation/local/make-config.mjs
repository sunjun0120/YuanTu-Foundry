/**
 * Write a run configuration for one batch: the base configuration plus explicit, non-secret overrides.
 *
 * `build-config.mjs` takes its overrides on the command line, which makes quoting JSON through a shell the caller's
 * problem. This reads the overrides from a file instead, so a pilot's budget authorization is written once, in the
 * clear, where it can be read back and audited. Secrets never appear here: the provider key is only ever read from
 * the environment by the adapter at request time.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureSourceManifest } from '../materialize.mjs';

const [out, batchId, endpointUrl, model, overridesFile] = process.argv.slice(2);
if (!out || !batchId || !endpointUrl || !model)
  throw new Error('usage: make-config.mjs <out> <batchId> <endpointUrl> <model> [overrides.json]');
const overrides = overridesFile
  ? JSON.parse(await readFile(path.resolve(overridesFile), 'utf8'))
  : {};
const source = path.resolve('.');
const captured = await captureSourceManifest(source);
const manifest = {
  version: 1,
  suiteVersion: 'project-seeded-v1',
  batchId,
  runtimeSource: { kind: 'snapshot', directory: source, manifestSha256: captured.hash },
  corpusSource: { kind: 'snapshot', directory: source, manifestSha256: captured.hash },
  cases: ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10'],
  repeats: 3,
  model,
  protocol: 'openai',
  endpointId: new URL(endpointUrl).host,
  endpointUrl,
  maxContextTokens: 128000,
  maxOutputTokens: 8192,
  reasoning: 'off',
  promptCache: 'off',
  toolMode: 'native',
  sandbox: 'host',
  caseConcurrency: 1,
  caseTimeoutMs: {
    E01: 300000,
    E02: 300000,
    E03: 300000,
    E04: 300000,
    E05: 600000,
    E06: 600000,
    E07: 600000,
    E08: 300000,
    E09: 600000,
    E10: 600000,
  },
  requestTimeoutMs: 120000,
  streamIdleTimeoutMs: 60000,
  verificationTimeoutMs: 180000,
  maxLiveAttempts: 30,
  maxObservedRequestsPerSample: 40,
  maxKnownTokensPerSample: 500000,
  approvedLiveBudget: {
    authorized: false,
    maxAttempts: 0,
    maxCurrency: null,
    currency: null,
    pricingSha256: null,
  },
  approvalMode: 'fixed-policy',
  ...overrides,
};
await writeFile(path.resolve(out), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  JSON.stringify({
    out: path.resolve(out),
    batchId,
    sourceHash: captured.hash,
    files: captured.files.length,
    authorized: manifest.approvedLiveBudget.authorized,
    maxAttempts: manifest.approvedLiveBudget.maxAttempts,
  }),
);
