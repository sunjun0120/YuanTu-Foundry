import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hash } from '../coding-evaluation/materialize.mjs';

export const DATASET = 'SWE-bench/SWE-bench_Verified';
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const recordHash = (record) => hash(JSON.stringify(canonical(record)));
export const serializeSubset = (subset) => `${JSON.stringify(subset, null, 2)}\n`;
function randomSource(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(records, random) {
  const values = [...records];
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
function groups(records, key) {
  const map = new Map();
  for (const record of records) {
    const value = record[key];
    if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}`);
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(record);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}
// Hamilton allocation with a minimum seat per repository, bounded by each stratum's capacity.
function allocate(strata, size, minimum) {
  const total = strata.reduce((sum, [, rows]) => sum + rows.length, 0);
  if (size > total || size < minimum * strata.length) throw new Error('Invalid subset size');
  const seats = strata.map(([, rows]) =>
    Math.max(minimum, Math.floor((size * rows.length) / total)),
  );
  const quotas = strata.map(([, rows]) => (size * rows.length) / total);
  while (seats.reduce((a, b) => a + b, 0) !== size) {
    const increase = seats.reduce((a, b) => a + b, 0) < size;
    const candidates = seats
      .map((n, i) => i)
      .filter((i) => (increase ? seats[i] < strata[i][1].length : seats[i] > minimum));
    candidates.sort((a, b) =>
      increase
        ? quotas[b] - seats[b] - (quotas[a] - seats[a]) || a - b
        : seats[b] - quotas[b] - (seats[a] - quotas[a]) || a - b,
    );
    if (!candidates.length) throw new Error('Cannot allocate subset');
    seats[candidates[0]] += increase ? 1 : -1;
  }
  return seats;
}
export function selectSubset(
  records,
  { revision, seed = 20261023, size = 50, smokeSize = 5 } = {},
) {
  if (
    !/^[a-f0-9]{40}$/.test(revision ?? '') ||
    !Number.isSafeInteger(seed) ||
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(smokeSize) ||
    smokeSize < 3 ||
    smokeSize > size
  )
    throw new Error('Invalid revision, seed or size');
  const ids = new Set();
  for (const record of records) {
    if (!/^[\w.-]+__[\w.-]+-\d+$/.test(record?.instance_id ?? '') || ids.has(record.instance_id))
      throw new Error('Invalid or duplicate instance id');
    ids.add(record.instance_id);
  }
  const sorted = [...records].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
  const repos = groups(sorted, 'repo');
  const seats = allocate(repos, size, 1);
  const random = randomSource(seed);
  const selected = repos
    .flatMap(([, rows], i) => {
      const difficulty = groups(rows, 'difficulty');
      const counts = allocate(difficulty, seats[i], 0);
      return difficulty.flatMap(([, candidates], j) =>
        shuffle(candidates, random).slice(0, counts[j]),
      );
    })
    .sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
  const easy = groups(
    selected.filter((r) => ['<15 min fix', '15 min - 1 hour'].includes(r.difficulty)),
    'repo',
  );
  if (easy.length < 3)
    throw new Error('Selected subset cannot supply smoke coverage of three repositories');
  const candidates = shuffle(easy, random).map(([, rows]) => shuffle(rows, random));
  const smoke = candidates
    .slice(0, Math.min(smokeSize, candidates.length))
    .map((rows) => rows.shift());
  smoke.push(...shuffle(candidates.flat(), random).slice(0, smokeSize - smoke.length));
  if (smoke.length !== smokeSize) throw new Error('Insufficient easy smoke instances');
  return {
    version: 1,
    dataset: DATASET,
    split: 'test',
    revision,
    seed,
    selection:
      'Hamilton repo proportions (minimum 1); Hamilton difficulty proportions within repo; mulberry32; sorted instance_id input',
    recordHash: 'sha256 of UTF-8 JSON with recursively sorted object keys, no whitespace',
    instances: selected.map((r) => ({
      instance_id: r.instance_id,
      repo: r.repo,
      difficulty: r.difficulty,
      sha256: recordHash(r),
    })),
    smoke: smoke.map((r) => r.instance_id).sort(),
  };
}
export async function readDataset(file) {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, revision, output] = process.argv.slice(2);
  if (!input || !revision || !output || process.argv.length !== 5)
    throw new Error('Usage: select-subset.mjs dataset.jsonl revision output.json');
  await writeFile(output, serializeSubset(selectSubset(await readDataset(input), { revision })), {
    flag: 'wx',
  });
}
