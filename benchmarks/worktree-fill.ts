import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';

/**
 * Freeze and child-worktree allocation cost on a synthetic repository.
 *
 * `node benchmarks/worktree-fill.ts [files] [fileKiB] [children]` builds a committed repository with one dirty file,
 * freezes it once and allocates `children` worktrees from that snapshot, reporting wall time per step and the
 * process's peak RSS. Numbers are machine-specific; compare runs on the same machine only.
 */

const files = Number(process.argv[2] ?? 2000);
const fileKiB = Number(process.argv[3] ?? 16);
const children = Number(process.argv[4] ?? 4);

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

const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-fill-'));
const store = new SessionStore(path.join(`${root}-state`, 'sessions.sqlite'));
try {
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  const body = Buffer.alloc(fileKiB * 1024);
  for (let i = 0; i < files; i++) {
    const dir = path.join(root, `d${i % 50}`);
    await mkdir(dir, { recursive: true });
    body.writeUInt32LE(i, 0);
    // Every tenth file repeats an earlier one's bytes, as generated or vendored trees do.
    if (i % 10 === 9) body.writeUInt32LE(i - 1, 0);
    await writeFile(path.join(dir, `f${i}.txt`), body);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  await writeFile(path.join(root, 'd0', 'f0.txt'), 'dirty\n');

  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const signal = new AbortController().signal;
  const rssBefore = process.memoryUsage().rss;
  let started = performance.now();
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal,
  });
  const freezeMs = performance.now() - started;
  const allocations: number[] = [];
  for (let child = 0; child < children; child++) {
    started = performance.now();
    await manager.allocate({ parentSessionId: session.id, taskId: `t${child}`, snapshot, signal });
    allocations.push(performance.now() - started);
  }
  clearInterval(sampler);
  const mib = (bytes: number) => Number((bytes / 1048576).toFixed(1));
  console.log(
    JSON.stringify(
      {
        files,
        fileKiB,
        treeMiB: mib(files * fileKiB * 1024),
        children,
        freezeMs: Math.round(freezeMs),
        allocateMs: allocations.map(Math.round),
        rssBeforeMiB: mib(rssBefore),
        peakRssMiB: mib(peakRss),
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampler);
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(`${root}-state`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
