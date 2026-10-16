import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TestDurations = Record<string, number>;
const environment = {
  nodeMajor: process.versions.node.split('.')[0],
  platform: process.platform,
  arch: process.arch,
};

/** Timing history is an optional scheduling hint, never evidence that a test passed. */
export async function readTestDurations(file: string): Promise<TestDurations> {
  try {
    const history = JSON.parse(await readFile(file, 'utf8'));
    if (
      history.schemaVersion !== 1 ||
      Object.entries(environment).some(([key, value]) => history[key] !== value) ||
      !history.files ||
      typeof history.files !== 'object' ||
      Array.isArray(history.files)
    )
      return {};
    return Object.fromEntries(
      Object.entries(history.files).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`Ignoring test duration history ${file}: ${(error as Error).message}`);
    return {};
  }
}

export function orderTestsByDuration(files: string[], durations: TestDurations): string[] {
  // Unmeasured files start alongside known slow files so a newly added slow case does not form a tail.
  const unknown = Math.max(0, ...Object.values(durations));
  const duration = (file: string) => durations[file] ?? unknown;
  return [...files].sort((a, b) => duration(b) - duration(a) || (a < b ? -1 : a > b ? 1 : 0));
}

export async function writeTestDurations(file: string, files: TestDurations): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, ...environment, files }, null, 2) + '\n',
      { flag: 'wx' },
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
