/** Fixed Git metadata operations owned by the Host, never an arbitrary command or an ACL exception. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { samePath } from '../platform/workspace-paths.ts';
import { repositoryWorktreeParent } from '../platform/worktree-home.ts';
import { currentExecutionPolicy } from '../sandbox/execution-policy.ts';
import { resolveSandboxConfig } from '../sandbox/sandbox-provider.ts';

type ReadGit = (args: readonly string[], signal: AbortSignal) => Promise<string>;
export interface GitInvocation {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
interface Output {
  content: string;
  truncated: boolean;
}
type RunGit = (invocation: GitInvocation, signal: AbortSignal) => Promise<Output>;
export type NativeGitMutation =
  | { kind: 'stage'; paths: string[]; unstage: boolean }
  | { kind: 'commit'; message: string; identity: { name: string; email: string } }
  | { kind: 'worktree'; branch: string; target: string };

const queues = new Map<string, Promise<void>>();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const nativeModes = new Set(['native', 'windows-account', 'seatbelt']);

export function nativeGitWrites(): boolean {
  const config = resolveSandboxConfig();
  if (config.files === 'read-only' || currentExecutionPolicy()?.files === 'read-only')
    throw new Error('Git metadata writes are not available under a read-only file policy');
  if (config.mode === 'host') return false;
  if (!nativeModes.has(config.mode))
    throw new Error('This execution backend does not support controlled Git metadata writes');
  return true;
}

async function optional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function boundary(repository: string) {
  if (!samePath(await realpath(repository), repository))
    throw new Error('Git repository identity changed');
  const entry = path.join(repository, '.git');
  const info = await lstat(entry);
  if (info.isSymbolicLink() || (info.nlink > 1 && info.isFile()))
    throw new Error('Git metadata links are not allowed');
  let directory = entry;
  if (info.isFile()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(entry, 'utf8'));
    if (!match) throw new Error('Invalid managed Git worktree metadata');
    directory = path.resolve(repository, match[1]!);
  } else if (!info.isDirectory()) throw new Error('Invalid Git metadata directory');
  if (!samePath(await realpath(directory), directory))
    throw new Error('Git metadata directory must not contain links');
  const commonFile = await optional(path.join(directory, 'commondir'));
  const common = commonFile
    ? path.resolve(directory, commonFile.toString('utf8').trim())
    : directory;
  if (!samePath(await realpath(common), common))
    throw new Error('Git common metadata must not contain links');
  if (directory !== entry) {
    if (
      path.basename(common) !== '.git' ||
      !inside(path.join(common, 'worktrees'), directory) ||
      directory === path.join(common, 'worktrees')
    )
      throw new Error('Git metadata is not an owned managed worktree');
    const owner = path.dirname(common);
    const legacy = samePath(path.dirname(repository), path.join(owner, '.yuantu', 'worktrees'));
    if (!legacy && !samePath(path.dirname(repository), repositoryWorktreeParent(owner)))
      throw new Error('Git worktree metadata is outside the managed worktree home');
    const reverse = (await readFile(path.join(directory, 'gitdir'), 'utf8')).trim();
    if (!samePath(path.resolve(directory, reverse), entry))
      throw new Error('Git worktree reverse link does not match');
  } else if (!samePath(common, directory))
    throw new Error('Git common metadata is outside the repository');
  const identities: string[] = [];
  let entries = 0;
  const scan = async (file: string): Promise<void> => {
    if (++entries > 100_000) throw new Error('Git metadata is too large to validate safely');
    const stat = await lstat(file, { bigint: true });
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1n))
      throw new Error('Git metadata links and shared hardlinks are not allowed');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Unsupported Git metadata entry');
    identities.push(
      `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    );
    if (stat.isDirectory())
      for (const name of (await readdir(file)).sort()) await scan(path.join(file, name));
  };
  await scan(common);
  if (!inside(common, directory)) await scan(directory);
  const rootStat = await lstat(repository, { bigint: true });
  identities.push(
    `${rootStat.dev}:${rootStat.ino}`,
    digest(await readFile(path.join(directory, 'HEAD'))),
  );
  if (info.isFile()) identities.push(digest(await readFile(entry)));
  const alternates = await optional(path.join(common, 'objects', 'info', 'alternates'));
  if (alternates?.toString('utf8').trim())
    throw new Error('Git object alternates are not supported by controlled metadata writes');
  return {
    directory,
    common,
    fingerprint: digest(identities.join('\n')),
    index: await optional(path.join(directory, 'index')),
  };
}

async function trustedGit(
  repository: string,
  common: string,
): Promise<{ executable: string; pathValue: string }> {
  const raw =
    Object.entries(process.env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories: string[] = [];
  for (const value of raw.split(path.delimiter)) {
    const directory = value.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(directory)) continue;
    try {
      const canonical = await realpath(directory);
      if (!inside(repository, canonical) && !inside(common, canonical)) directories.push(canonical);
    } catch {
      /* An absent PATH entry cannot supply Git. */
    }
  }
  // Seatbelt grants Apple's Git launcher and its developer tools. Homebrew Git can depend on
  // Cellar libraries outside those grants; selecting it from PATH makes native Git fail at dyld.
  // Keep the system tool as the macOS trust anchor rather than widening the sandbox to Homebrew.
  for (const directory of process.platform === 'darwin' ? ['/usr/bin'] : directories) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      const executable = await realpath(candidate);
      if (inside(repository, executable) || inside(common, executable)) continue;
      const info = await lstat(executable);
      if (!info.isFile()) continue;
      await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return {
        executable,
        pathValue: (process.platform === 'darwin'
          ? ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
          : directories
        ).join(path.delimiter),
      };
    } catch {
      /* Keep searching trusted absolute PATH entries. */
    }
  }
  throw new Error(
    'A Git executable outside the workspace is required for controlled metadata writes',
  );
}

/** Discovery and security reads must use the same trusted program as the metadata writer. */
export async function nativeGitExecutable(root: string): Promise<string> {
  const canonical = await realpath(root);
  return (await trustedGit(canonical, canonical)).executable;
}

/** The three identity/signing reads may consult the user's config without granting an arbitrary Host query. */
export async function nativeGitIdentityQuery(
  repository: string,
  key: string,
  asBool: boolean,
  env: NodeJS.ProcessEnv,
): Promise<GitInvocation> {
  if (!['user.name', 'user.email', 'commit.gpgsign'].includes(key))
    throw new Error('Unsupported native Git identity query');
  const metadata = await boundary(repository);
  const trusted = await trustedGit(repository, metadata.common);
  return {
    executable: trusted.executable,
    args: [
      '-c',
      `safe.directory=${repository.replaceAll('\\', '/')}`,
      'config',
      '--get',
      ...(asBool ? ['--bool'] : []),
      key,
    ],
    env: { ...env, PATH: trusted.pathValue, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  };
}

function configEntries(text: string): Map<string, string> {
  if (text.includes('[output truncated]'))
    throw new Error('Git configuration exceeds the metadata validation limit');
  const entries = new Map<string, string>();
  for (const entry of text.split('\0').filter(Boolean)) {
    const split = entry.indexOf('\n');
    const key = split < 0 ? entry : entry.slice(0, split);
    if (/[\x00-\x20=\x7f]/.test(key)) throw new Error('Unsupported Git configuration key');
    const value = split < 0 ? '' : entry.slice(split + 1);
    if (/^include(?:if\..*)?\.path$/i.test(key))
      throw new Error(
        'Git config includes are not supported by controlled metadata writes; included files can change outside protected metadata',
      );
    if (
      /^extensions\.partialclone$/i.test(key) ||
      (/^remote\..*\.promisor$/i.test(key) && !/^(false|no|off|0)$/i.test(value))
    )
      throw new Error(
        'Partial-clone Git repositories require fetch support and cannot use controlled metadata writes',
      );
    entries.set(key, value);
  }
  return entries;
}

function rejectFilters(operation: NativeGitMutation, config: Map<string, string>) {
  if (operation.kind === 'commit' || (operation.kind === 'stage' && operation.unstage)) return;
  for (const [key, value] of config) {
    const match = /^filter\.(.*)\.(clean|smudge|process|required)$/i.exec(key);
    if (
      match &&
      (value || match[2]!.toLowerCase() === 'required') &&
      !(match[2]!.toLowerCase() === 'required' && /^(false|no|off|0)$/i.test(value))
    )
      throw new Error(
        `Git filter ${match[1]} is configured; controlled native staging and checkout cannot safely execute filters or freeze concurrent attribute edits`,
      );
  }
}

/** Preparation only reads. Each execution rechecks the approved snapshot under the common-dir queue. */
export async function prepareNativeGitWrite(
  repository: string,
  operation: NativeGitMutation,
  read: ReadGit,
  signal: AbortSignal,
) {
  nativeGitWrites();
  const original = await boundary(repository);
  const configText = await read(['config', '--null', '--list', '--includes'], signal);
  const config = configEntries(configText);
  rejectFilters(operation, config);
  const trusted = await trustedGit(repository, original.common);
  const approved = await boundary(repository);
  const headText = (await readFile(path.join(approved.directory, 'HEAD'), 'utf8')).trim();
  if (!/^(ref: refs\/heads\/[^\x00-\x20]+|[0-9a-f]{40}|[0-9a-f]{64})$/.test(headText))
    throw new Error('Unsupported Git HEAD');
  let head: string | undefined;
  try {
    head = (await read(['rev-parse', '--verify', '--quiet', 'HEAD'], signal)).trim();
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode !== 1) throw error;
  }
  const reference = headText.startsWith('ref: ') ? headText.slice(5) : 'HEAD';
  return {
    async execute(
      run: RunGit,
      env: NodeJS.ProcessEnv,
      executeSignal: AbortSignal,
    ): Promise<Output> {
      const key = process.platform === 'win32' ? approved.common.toLowerCase() : approved.common;
      const preceding = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const flight = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(key, flight);
      await preceding;
      let scratch: string | undefined;
      try {
        executeSignal.throwIfAborted();
        nativeGitWrites();
        const current = await boundary(repository);
        if (
          current.fingerprint !== approved.fingerprint ||
          digest(current.index ?? '') !== digest(approved.index ?? '') ||
          (await read(['config', '--null', '--list', '--includes'], executeSignal)) !== configText
        )
          throw new Error(
            'Git metadata or staged content changed during approval; inspect it and request approval again',
          );
        rejectFilters(operation, config);
        scratch = await mkdtemp(path.join(tmpdir(), 'yuantu-git-metadata-'));
        const hooks = path.join(scratch, 'hooks');
        // A nonexistent path inside private Host scratch supplies no hooks, including post-commit/post-checkout.
        const settings = [
          `safe.directory=${repository.replaceAll('\\', '/')}`,
          'core.bare=false',
          `core.worktree=${repository}`,
          `core.hooksPath=${hooks}`,
          'core.fsmonitor=false',
          'core.untrackedCache=false',
          'core.attributesFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
          'core.protectHFS=true',
          'core.protectNTFS=true',
          'commit.gpgsign=false',
          'gc.auto=0',
          'maintenance.auto=false',
          'submodule.recurse=false',
          'protocol.allow=never',
          'diff.external=',
          'core.pager=',
        ];
        for (const [name] of config)
          if (/^filter\..*\.(clean|smudge|process|required)$/i.test(name))
            settings.push(`${name}=${/\.required$/i.test(name) ? 'false' : ''}`);
        const prefix = [
          '--git-dir=' + approved.directory,
          '--work-tree=' + repository,
          ...settings.flatMap((setting) => ['-c', setting]),
          '--no-pager',
        ];
        const processEnv: NodeJS.ProcessEnv = {
          ...env,
          PATH: trusted.pathValue,
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_LITERAL_PATHSPECS: '1',
          TMP: scratch,
          TEMP: scratch,
          TMPDIR: scratch,
        };
        const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
          run(
            {
              executable: trusted.executable,
              args: [...prefix, ...args],
              env: { ...processEnv, ...extra },
            },
            executeSignal,
          );
        if (operation.kind === 'stage')
          return await invoke(
            operation.unstage
              ? ['reset', '-q', 'HEAD', '--', ...operation.paths]
              : ['add', '--', ...operation.paths],
          );
        if (operation.kind === 'worktree') {
          // Native preparation above refreshes reserved-name protection. Check the destination only afterwards:
          // a parent replaced during that refresh must not redirect a privileged checkout.
          const parent = path.join(repository, '.yuantu', 'worktrees');
          if (path.dirname(operation.target) !== parent)
            throw new Error('Git worktree target must stay in the managed worktree directory');
          for (const directory of [path.join(repository, '.yuantu'), parent]) {
            const info = await lstat(directory);
            if (
              !info.isDirectory() ||
              info.isSymbolicLink() ||
              !samePath(await realpath(directory), directory)
            )
              throw new Error('Git worktree parent changed or contains a link');
          }
          try {
            await lstat(operation.target);
            throw new Error('Git worktree target already exists');
          } catch (error) {
            if (!missing(error)) throw error;
          }
          return await invoke([
            'worktree',
            'add',
            '-b',
            operation.branch,
            operation.target,
            'HEAD',
          ]);
        }
        // An immutable private index plus conditional ref update binds the commit to exactly what was approved.
        const index = path.join(scratch, 'index');
        if (!approved.index) throw new Error('Nothing is staged');
        await writeFile(index, approved.index, { flag: 'wx', mode: 0o600 });
        const tree = (await invoke(['write-tree'], { GIT_INDEX_FILE: index })).content.trim();
        const commit = (
          await invoke(
            ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', operation.message],
            {
              GIT_AUTHOR_NAME: operation.identity.name,
              GIT_AUTHOR_EMAIL: operation.identity.email,
              GIT_COMMITTER_NAME: operation.identity.name,
              GIT_COMMITTER_EMAIL: operation.identity.email,
            },
          )
        ).content.trim();
        const unchanged = await boundary(repository);
        if (
          digest(unchanged.index ?? '') !== digest(approved.index) ||
          (await readFile(path.join(approved.directory, 'HEAD'), 'utf8')).trim() !== headText
        )
          throw new Error('Git index or HEAD changed after approval; no reference was updated');
        await invoke([
          'update-ref',
          '-m',
          'commit: ' + operation.message.split('\n')[0],
          '--no-deref',
          reference,
          commit,
          head ?? '0'.repeat(config.get('extensions.objectformat') === 'sha256' ? 64 : 40),
        ]);
        return { content: `Committed ${commit}`, truncated: false };
      } finally {
        try {
          if (scratch) await rm(scratch, { recursive: true, force: true });
        } finally {
          release();
          if (queues.get(key) === flight) queues.delete(key);
        }
      }
    },
  };
}
