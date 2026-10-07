import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runDelegationCase } from './performance-delegation.ts';
import { summarizePairs } from './performance-cases.ts';

const args = process.argv.slice(2);
if (args.some((arg) => !/^--(?:pairs=\d+|out=.+)$/.test(arg)))
  throw new Error('Unsupported delegation option');
const pairs = Number(args.find((arg) => arg.startsWith('--pairs='))?.slice(8) ?? 10);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 100)
  throw new Error('pairs must be 1..100');
const directory = path.resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice(6) ?? `.scratch/delegation-${Date.now()}`,
);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'measurements.jsonl'), '', { flag: 'wx' });
const rows = [];
for (let pair = 0; pair < pairs; pair++) {
  for (const variant of pair % 2 ? ['overlap', 'blocking'] : ['blocking', 'overlap']) {
    const row = { pair, ...(await runDelegationCase({ variant })) };
    rows.push(row);
    await appendFile(path.join(directory, 'measurements.jsonl'), JSON.stringify(row) + '\n');
    console.log(
      JSON.stringify({
        pair,
        variant,
        verified: row.verified,
        wallMs: row.wallMs,
        overlapMs: row.overlapMs,
        requests: row.requests,
      }),
    );
  }
}
await writeFile(
  path.join(directory, 'analysis.json'),
  JSON.stringify(summarizePairs(rows, 'blocking', 'overlap'), null, 2) + '\n',
);
if (rows.some((row) => !row.verified)) process.exitCode = 1;
