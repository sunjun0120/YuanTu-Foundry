import path from 'node:path';
import { mkdir, access, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function gitEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ])
    if (source[key]) env[key] = source[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  };
}
export async function git(directory, args) {
  return (
    await exec(
      'git',
      [
        '--no-pager',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.longpaths=true',
        '-c',
        'core.hooksPath=',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.attributesFile=',
        '-c',
        'diff.external=',
        '-c',
        'credential.helper=',
        '-c',
        'protocol.ext.allow=never',
        ...args,
      ],
      { cwd: directory, env: gitEnvironment(), windowsHide: true, maxBuffer: 64_000_000 },
    )
  ).stdout;
}
export async function materializeRepo({ record, cacheDirectory, directory, source }) {
  const started = performance.now();
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
  // Strategy B: a complete base tree, zero parent history, and no promisor/alternates.
  // Fetch from the real source: a partial cache's upload-pack cannot promise missing blobs.
  // No remote remains for model-time lazy fetching; older objects fail locally and immediately.
  await git(directory, ['init']);
  await git(directory, ['config', '--local', 'core.autocrlf', 'false']);
  await git(directory, ['config', '--local', 'core.longpaths', 'true']);
  await git(directory, [
    'remote',
    'add',
    'origin',
    source ?? `https://github.com/${record.repo}.git`,
  ]);
  await git(directory, ['fetch', '--no-tags', '--depth=1', 'origin', record.base_commit]);
  await git(directory, ['checkout', '--detach', record.base_commit]);
  await git(directory, ['remote', 'remove', 'origin']);
  if (
    (await git(directory, ['rev-parse', 'HEAD'])).trim() !== record.base_commit ||
    (await git(directory, ['status', '--porcelain'])).trim()
  )
    throw new Error('Materialized repository is not clean at base_commit');
  const metadataBytes = async (root) => {
    let bytes = 0;
    for (const item of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name);
      if (item.isDirectory()) bytes += await metadataBytes(file);
      else if (item.isFile()) bytes += (await stat(file)).size;
    }
    return bytes;
  };
  return {
    directory,
    baseCommit: record.base_commit,
    cache,
    materialization: {
      strategy: 'complete-base-tree',
      historyDepth: 0,
      metadataBytes: await metadataBytes(path.join(directory, '.git')),
      durationMs: Math.round(performance.now() - started),
    },
  };
}
