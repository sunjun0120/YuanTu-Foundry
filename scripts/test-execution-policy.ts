import { readdir } from 'node:fs/promises';
import path from 'node:path';
export {
  partitionIsolatedTests as partitionTests,
  serialResources,
  testResources,
  TEST_RESOURCES,
} from './test-resource-policy.ts';
export type { TestResource, TestPartition, PartitionOptions } from './test-resource-policy.ts';
/**
 * Suites that grade the product itself, and cost minutes each rather than seconds.
 *
 * `npm test` is the loop a developer runs after every edit, so what belongs in it is what answers
 * "did I break the thing I just changed". These two do not: they freeze a copy of the whole source
 * tree, copy locked dependencies and drive a real Host through a scripted corpus. Measured on this
 * checkout they are the two most expensive files in the suite — 165 s and 150 s against a 4.6 s
 * median — and neither of them reports anything an ordinary change could not have broken more
 * cheaply elsewhere. They still run, as their own gate (`npm run test:eval`) and on every CI run;
 * naming them on the command line bypasses discovery, so nothing is unreachable.
 */
export const EVAL_TESTS = ['tests/coding-evaluation.test.ts', 'tests/swe-bench.test.ts'] as const;

export function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}
export async function discoverTests(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, 'tests'), { withFileTypes: true });
  const graded = new Set<string>(EVAL_TESTS);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/${entry.name}`)
    .filter((file) => !graded.has(file))
    .sort();
}
