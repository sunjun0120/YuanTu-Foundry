/**
 * Which test files may run at the same time as another test file, and why.
 *
 * The suite is a single serial harness today because a few of its tests touch things a second
 * process must not touch at the same time: the Windows sandbox's fixed user state directory, the
 * real desktop UI, Office automation, fixed ports and the shared build output. Everything else is
 * merely *unproven*, and unproven is serial: this module never infers safety from a file's name,
 * directory, duration or static import graph.
 *
 * The claim "this file is safe to run concurrently" is an external review result, not something a
 * program can derive. So it is recorded per file in `test-parallel-safe.json`, together with the
 * exact bytes that were reviewed. Any edit to the test file or to a reviewed local dependency
 * changes a hash and drops the entry back to serial until a human reviews it again.
 *
 * The default policy has no entries at all: with no reviewed file, every test is serial and the
 * suite behaves exactly as it does today.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface PolicyInput {
  /** Repository-relative path of a file the review read. */
  file: string;
  /** SHA-256 of that file's bytes at review time. */
  sha256: string;
}

export interface ParallelEntry {
  /** Repository-relative test path, e.g. `tests/slots.test.ts`. */
  file: string;
  /** Why this file may overlap with another test file. Written by the reviewer, for a human. */
  reason: string;
  /** The reviewed inputs: the test file and every local dependency/fixture it reaches. */
  inputs: PolicyInput[];
}

export interface ParallelPolicy {
  version: 1;
  entries: ParallelEntry[];
}

export interface TestPartition {
  parallel: string[];
  serial: string[];
  /** Every file in the input gets a reason, whether it ended up parallel or serial. */
  reasons: Record<string, string>;
}

export interface PartitionOptions {
  /** Absolute repository root. */
  root: string;
  policy: ParallelPolicy;
  /** Hashing seam for tests; defaults to SHA-256 of the file's bytes. */
  hashFile?: (absolutePath: string) => Promise<string>;
  /**
   * Whether a listed entry whose test file cannot be found in `discovered` is an error.
   *
   * True for the full suite: the policy and the discovery set are supposed to agree, and a typo
   * that silently disabled an entry would be invisible. False for an explicit file list, whose
   * caller is looking at a subset on purpose.
   */
  strictFiles?: boolean;
}

export const EMPTY_POLICY: ParallelPolicy = { version: 1, entries: [] };

const SHA256 = /^[0-9a-f]{64}$/;
const TEST_FILE = /^tests\/[^/]+\.test\.ts$/;

/** Repository-relative, forward-slashed, without a leading `./`. */
export function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function defaultHash(absolutePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
}

/**
 * The one discovery rule in the suite: the top-level `tests/*.test.ts` files, sorted.
 *
 * `run-tests.mjs`, `select-tests.ts`, the coverage gate and the docs counts all depend on this set,
 * so there is deliberately one function rather than a glob per call site. Files in subdirectories
 * are not behavior tests and are never run by the default entry point.
 */
export async function discoverTests(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, 'tests'), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

/**
 * Validate a policy document and return it, or throw with every problem it found.
 *
 * A malformed policy is a configuration error, not a silently-ignored hint: `--plan` and the
 * partitioned schedule both fail rather than run a schedule nobody reviewed.
 *
 * `tolerateUnknown` is for the one caller that is not looking at the whole suite: a run of explicit
 * file paths. Its entries naming files outside that list are irrelevant rather than wrong, because
 * the review they record is being validated against whatever it *did* claim. Entries naming files
 * inside the list are still held to every rule.
 */
export function validatePolicy(
  policy: unknown,
  discovered: string[],
  options: { tolerateUnknown?: boolean } = {},
): ParallelPolicy {
  const problems: string[] = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw new Error('test-parallel-safe.json must be an object');
  const document = policy as { version?: unknown; entries?: unknown };
  if (document.version !== 1)
    problems.push(`version must be 1, got ${JSON.stringify(document.version)}`);
  if (!Array.isArray(document.entries)) {
    problems.push('entries must be an array');
    throw new Error(`Invalid parallel-safe policy:\n- ${problems.join('\n- ')}`);
  }
  const known = new Set(discovered);
  const seen = new Set<string>();
  const entries: ParallelEntry[] = [];
  document.entries.forEach((raw, index) => {
    const at = `entries[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const entry = raw as { file?: unknown; reason?: unknown; inputs?: unknown };
    const file = typeof entry.file === 'string' ? normalizeRepoPath(entry.file) : undefined;
    const relevant = !options.tolerateUnknown || file === undefined || known.has(file);
    if (!file) problems.push(`${at}.file must be a string`);
    else if (!TEST_FILE.test(file))
      problems.push(`${at}.file must be a top-level test file, got ${file}`);
    else if (!known.has(file) && !options.tolerateUnknown)
      problems.push(`${at}.file is not a discovered test: ${file}`);
    else if (seen.has(file)) problems.push(`${at}.file is listed twice: ${file}`);
    else seen.add(file);
    if (typeof entry.reason !== 'string' || !entry.reason.trim())
      problems.push(`${at}.reason must be a non-empty string`);
    const inputs: PolicyInput[] = [];
    if (!Array.isArray(entry.inputs) || !entry.inputs.length) {
      problems.push(`${at}.inputs must list the reviewed files`);
    } else {
      entry.inputs.forEach((rawInput, inputIndex) => {
        const inputAt = `${at}.inputs[${inputIndex}]`;
        if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
          problems.push(`${inputAt} must be an object`);
          return;
        }
        const input = rawInput as { file?: unknown; sha256?: unknown };
        const inputFile =
          typeof input.file === 'string' ? normalizeRepoPath(input.file) : undefined;
        if (!inputFile) problems.push(`${inputAt}.file must be a string`);
        else if (
          inputFile.startsWith('/') ||
          /^[A-Za-z]:/.test(inputFile) ||
          inputFile.includes('..')
        )
          problems.push(`${inputAt}.file escapes the repository: ${inputFile}`);
        if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256))
          problems.push(`${inputAt}.sha256 must be a lowercase SHA-256 hex digest`);
        if (inputFile && typeof input.sha256 === 'string' && SHA256.test(input.sha256))
          inputs.push({ file: inputFile, sha256: input.sha256 });
      });
      if (
        relevant &&
        typeof file === 'string' &&
        !inputs.some((input) => input.file === normalizeRepoPath(file))
      )
        problems.push(`${at}.inputs must include the test file itself: ${file}`);
    }
    if (relevant && typeof file === 'string' && typeof entry.reason === 'string' && inputs.length)
      entries.push({ file, reason: entry.reason, inputs });
  });
  if (problems.length) throw new Error(`Invalid parallel-safe policy:\n- ${problems.join('\n- ')}`);
  return { version: 1, entries };
}

/** Read and validate `test-parallel-safe.json` from the repository root. */
export async function loadPolicy(
  root: string,
  discovered: string[],
  options: { tolerateUnknown?: boolean } = {},
): Promise<ParallelPolicy> {
  let text: string;
  try {
    text = await readFile(path.join(root, 'test-parallel-safe.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_POLICY };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`test-parallel-safe.json is not valid JSON: ${(error as Error).message}`);
  }
  return validatePolicy(parsed, discovered, options);
}

/**
 * Split the discovered tests into the two mutually exclusive phases.
 *
 * An entry only survives when every one of its reviewed inputs still hashes to the value recorded
 * at review time. A missing file counts as changed. Entries are evaluated against the files
 * actually being run, so asking for one file does not drag the rest of the policy in with it.
 */
export async function partitionTests(
  files: string[],
  options: PartitionOptions & { strictFiles?: boolean },
): Promise<TestPartition> {
  const { root, policy, hashFile = defaultHash, strictFiles = true } = options;
  const discovered = files.map(normalizeRepoPath);
  validatePolicy(policy, discovered, { tolerateUnknown: !strictFiles });
  const byFile = new Map(policy.entries.map((entry) => [entry.file, entry]));
  const parallel: string[] = [];
  const serial: string[] = [];
  const reasons: Record<string, string> = {};
  for (const file of discovered) {
    const entry = byFile.get(file);
    if (!entry) {
      serial.push(file);
      reasons[file] = 'not reviewed for concurrent execution; serial by default';
      continue;
    }
    const changed: string[] = [];
    for (const input of entry.inputs) {
      const actual = await hashFile(path.resolve(root, input.file)).catch(() => null);
      if (actual === null) changed.push(`${input.file} (missing)`);
      else if (actual !== input.sha256) changed.push(input.file);
    }
    if (changed.length) {
      serial.push(file);
      reasons[file] = `reviewed inputs changed since review: ${changed.join(', ')}`;
      continue;
    }
    parallel.push(file);
    reasons[file] = entry.reason;
  }
  parallel.sort();
  serial.sort();
  return { parallel, serial, reasons };
}
