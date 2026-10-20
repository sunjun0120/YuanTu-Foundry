import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../packages/workspaces/results.ts';

/**
 * Result-export cost on a synthetic repository: the first export against consecutive turns.
 *
 * `node benchmarks/worktree-export.ts [files] [fileKiB] [rounds]` builds a committed repository, allocates one
 * worktree child from a frozen snapshot, and exports what the child changed once per round. The first export reads
 * the whole tree; later exports reuse the blob cache and should only stat the unchanged files. The difference is
 * the number this benchmark exists to keep visible, and the 10k/50k shapes are the ones the audit asked for.
 *
 * Numbers are machine-specific; compare runs on the same machine only. The child worktree lives outside the
 * temporary repository (that is the product's own layout), so the run removes it through the manager before it
 * exits.
 */

const files = Number(process.argv[2] ?? 10_000);
const fileKiB = Number(process.argv[3] ?? 1);
const rounds = Number(process.argv[4] ?? 3);
if (!Number.isSafeInteger(files) || files < 1 || files > 200_000)
  throw new Error('files must be an integer between 1 and 200000');
if (!Number.isSafeInteger(fileKiB) || fileKiB < 1 || fileKiB > 1024)
  throw new Error('fileKiB must be an integer between 1 and 1024');
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10)
  throw new Error('rounds must be an integer between 1 and 10');

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Bench',
  GIT_AUTHOR_EMAIL: 'bench@example.com',
  GIT_COMMITTER_NAME: 'Bench',
  GIT_COMMITTER_EMAIL: 'bench@example.com',
};
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);

const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-export-'));
const store = new SessionStore(path.join(`${root}-state`, 'sessions.sqlite'));
const signal = new AbortController().signal;
let bindingId: string | undefined;
try {
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  const directories = Array.from({ length: 50 }, (_, index) =>
    path.join(root, `d${String(index)}`),
  );
  for (const directory of directories) await mkdir(directory, { recursive: true });
  // Batched writes: 50k sequential `writeFile` calls spend more time in antivirus and syscall latency than the
  // export this benchmark is about, and the setup is not what a caller waits for.
  const pendingWrites: Promise<void>[] = [];
  for (let index = 0; index < files; index++) {
    // Text rather than zero-filled buffers: an export refuses a result it cannot read as UTF-8, and the number
    // this benchmark measures must be the cost of the tree, not of a refusal path.
    const header = `${String(index).padStart(10, '0')}\n`;
    const body = header + 'x'.repeat(Math.max(0, fileKiB * 1024 - header.length));
    pendingWrites.push(
      writeFile(path.join(directories[index % directories.length]!, `f${String(index)}.txt`), body),
    );
    if (pendingWrites.length >= 64) {
      await Promise.all(pendingWrites);
      pendingWrites.length = 0;
    }
  }
  await Promise.all(pendingWrites);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);

  const manager = new WorkspaceManager({ store });
  const parent = store.create(root);
  const snapshot = await manager.freeze({
    parentSessionId: parent.id,
    sourceBinding: manager.resolve(parent.id),
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: parent.id,
    taskId: 'export-bench',
    snapshot,
    signal,
  });
  bindingId = binding.id;
  const child = store.create(root, parent.id);
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  const results = new WorkspaceResultsService({ store });

  const exportMs: number[] = [];
  const exportFiles: number[] = [];
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      // One changed file is the ordinary turn: everything else should be stat-only on the next export.
      await writeFile(path.join(binding.executionRoot, 'd0', 'f0.txt'), `round ${String(round)}\n`);
    }
    const started = performance.now();
    const result = await results.export({ childSessionId: child.id, signal });
    exportMs.push(performance.now() - started);
    exportFiles.push(result.paths.length);
  }

  const mib = (bytes: number) => Number((bytes / 1048576).toFixed(1));
  console.log(
    JSON.stringify(
      {
        files,
        fileKiB,
        rounds,
        treeMiB: mib(files * fileKiB * 1024),
        firstExportMs: Math.round(exportMs[0]!),
        nextExportMs: exportMs.slice(1).map(Math.round),
        exportedPaths: exportFiles,
        peakRssMiB: mib(peakRss),
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampler);
  if (bindingId) {
    await new WorkspaceManager({ store }).remove(bindingId, signal).catch(() => undefined);
  }
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(`${root}-state`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
