import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { WINDOWS_LEGACY_ACCEPTANCE_FILES } from './windows-sandbox-suites.mjs';
export {
  partitionIsolatedTests as partitionTests,
  serialResources,
  testResources,
  TEST_RESOURCES,
} from './test-resource-policy.ts';
export type { TestResource, TestPartition, PartitionOptions } from './test-resource-policy.ts';
export function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}
export async function discoverTests(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, 'tests'), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/${entry.name}`)
    .filter((file) => !WINDOWS_LEGACY_ACCEPTANCE_FILES.includes(file))
    .sort();
}
