import path from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function git(directory, args) {
  return (
    await exec(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.hooksPath=', ...args],
      { cwd: directory, windowsHide: true, maxBuffer: 64_000_000 },
    )
  ).stdout;
}
export async function materializeRepo({ record, cacheDirectory, directory, source }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repo) ||
    record.repo.split('/').some((p) => p === '.' || p === '..') ||
    !/^[a-f0-9]{40}$/.test(record.base_commit)
  )
    throw new Error('Invalid repository or base commit');
  directory = path.resolve(directory);
  const cache = path.resolve(cacheDirectory, `${record.repo.replace('/', '__')}.git`);
  await mkdir(cacheDirectory, { recursive: true });
  let exists = true;
  try {
    await access(cache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists)
    await git(cacheDirectory, [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--',
      source ?? `https://github.com/${record.repo}.git`,
      cache,
    ]);
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.longpaths', 'true'],
  ])
    await git(cache, ['config', '--local', key, value]);
  await git(cache, ['cat-file', '-e', `${record.base_commit}^{commit}`]);
  await mkdir(directory);
  // Keep the cache's promisor configuration: a shared clone loses lazy blob fetching.
  await git(cache, ['worktree', 'add', '--detach', '--', directory, record.base_commit]);
  if (
    (await git(directory, ['rev-parse', 'HEAD'])).trim() !== record.base_commit ||
    (await git(directory, ['status', '--porcelain'])).trim()
  )
    throw new Error('Materialized repository is not clean at base_commit');
  return { directory, baseCommit: record.base_commit, cache };
}
