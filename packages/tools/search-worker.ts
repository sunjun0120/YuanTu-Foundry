import { parentPort, workerData } from 'node:worker_threads';
import { scanText, searchOptions } from '../search/text.ts';
import type { FileEntry, WorkspaceAccess } from '../search/types.ts';

/**
 * The regular-expression backend, still a worker thread and still interruptible.
 *
 * `regex` mode has always run out of process, and for a reason that has not changed: a pattern with nested
 * quantifiers can take exponential time on one line, and the only way to stop that from the outside is to kill
 * the thread. What *has* changed is that the worker no longer reads a 256000-byte prefix of each file — it calls
 * the same streaming scanner the literal path uses, so a match past the old prefix is found here too, and the
 * coverage it returns is the same shape the literal path returns.
 *
 * This file deliberately imports `../search/text.ts` rather than `./files.ts`: pulling the tool module in would
 * load the registry, Ajv and every sibling tool into a thread whose whole job is to read files and match lines.
 * The search package has no such dependencies, which is exactly why it can be shared this way.
 */
interface SearchInput {
  root: string;
  files: { path: string; label: string }[];
  query: string;
  sensitive: boolean;
  limit: number;
  maxScanBytes: number;
  /** The worker's own budget. Kept below the caller's hard timeout so partial results beat a killed thread. */
  timeoutMs: number;
  maxOutputChars: number;
}

const input = workerData as SearchInput;

/**
 * The narrowest possible access: the root, for the containment check, and a refusal for everything else.
 *
 * Nothing here resolves or filters — the tool layer already admitted these paths, and a second policy in a
 * thread would be one more place for the two to disagree. `resolve` is never called by the scanner.
 */
const access: WorkspaceAccess = {
  root: input.root,
  resolve: async (relative: string) => {
    throw new Error(`Search worker does not resolve paths (${relative})`);
  },
  isExcluded: () => false,
};

const entries: FileEntry[] = input.files.map((file) => ({
  path: file.label,
  absolutePath: file.path,
  // Enumeration happened in the tool process; the scanner's containment check is what needs the root, and the
  // scan re-stats a file it is about to report as changed, so a zeroed fingerprint is enough here.
  fingerprint: { size: 0, mtimeMs: 0, sha256: null },
}));

async function* listed(): AsyncGenerator<FileEntry> {
  for (const entry of entries) yield entry;
}

const page = await scanText(
  access,
  listed(),
  searchOptions({
    query: input.query,
    mode: 'regex',
    caseMode: input.sensitive ? 'sensitive' : 'insensitive',
    maxResults: input.limit,
    maxOutputChars: input.maxOutputChars,
    maxScanBytes: input.maxScanBytes,
    timeoutMs: input.timeoutMs,
    // The tool layer owns cancellation and terminates this thread; there is no signal to forward.
    signal: new AbortController().signal,
  }),
);

parentPort!.postMessage({
  matches: page.matches,
  coverage: page.coverage,
  outputTruncated: page.outputTruncated,
});
