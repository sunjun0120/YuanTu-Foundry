import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceFailure, gitObjectId } from '../protocol/workspaces.ts';
import { canonicalKey, gitPath, isUnsafeGitPath, samePath } from '../platform/workspace-paths.ts';
import { repositoryWorktreeParent } from '../platform/worktree-home.ts';

/**
 * The Git plumbing the workspace service is built on.
 *
 * Three properties shape everything here, and each of them is a policy rather than a convenience:
 *
 * - **Arguments are arrays, never command lines.** A path with a space, a quote or a Chinese character is a path
 *   this feature must handle exactly, so nothing is ever assembled into a string a shell could re-split.
 * - **Configuration is masked and plumbing is used.** The user's `core.hooksPath`, `clean`/`smudge` filters,
 *   aliases and external diffs describe how *their* Git behaves; freezing a baseline must not run any of it. Every
 *   call therefore masks the global and system config and passes `-c` values that disable the mechanisms which
 *   could execute a repository-controlled program.
 * - **Output is bounded and cancellable.** A snapshot walks a whole working tree, so a command may produce a lot
 *   of text; capturing it without a cap turns a large repository into a memory problem, and ignoring the signal
 *   turns a cancelled delegation into a process that keeps walking.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Raised for a Git command that exited non-zero, carrying the code so a caller can distinguish "absent". */
export class WorkspaceGitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr = '') {
    super(message);
    this.name = 'WorkspaceGitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * The environment Git runs in: enough to find itself, and nothing that describes the user's habits.
 *
 * `GIT_CONFIG_GLOBAL` pointing at the null device is the load-bearing one. Masking it is what makes
 * `commit-tree` use the identity this service passes with `-c` instead of the user's, and what keeps a
 * `core.hooksPath` set in `~/.gitconfig` from being consulted while a worktree is registered.
 */
export function workspaceGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'TMP',
    'TEMP',
    'TMPDIR',
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = process.platform === 'win32' ? 'echo' : '/bin/echo';
  env.GCM_INTERACTIVE = 'Never';
  env.LC_ALL = 'C';
  // The service's own identity, fixed rather than derived: a synthetic baseline commit must be attributable to
  // the runtime, and must never be written as if the user had made it.
  env.GIT_AUTHOR_NAME = WORKSPACE_GIT_IDENTITY.name;
  env.GIT_AUTHOR_EMAIL = WORKSPACE_GIT_IDENTITY.email;
  env.GIT_COMMITTER_NAME = WORKSPACE_GIT_IDENTITY.name;
  env.GIT_COMMITTER_EMAIL = WORKSPACE_GIT_IDENTITY.email;
  return { ...env, ...extra };
}

/**
 * The identity synthetic baseline commits are made under.
 *
 * Fixed and local: `commit-tree` needs *an* identity, the user's is masked, and asking them to configure one in
 * order to delegate work would be a new setup step this feature does not need.
 */
export const WORKSPACE_GIT_IDENTITY = {
  name: 'YuanTu Workspace',
  email: 'workspace@yuantu.local',
} as const;

/**
 * Configuration that removes every way a Git command could run repository-controlled code.
 *
 * Applied to *every* invocation, reads included: freezing a tree reads object data, and a `diff.external` or a
 * textconv driver would happily turn that into program execution.
 */
const MASKING_CONFIG: readonly string[] = [
  '-c',
  'color.ui=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'diff.trustExitCode=false',
  '-c',
  'filter.workspace.clean=',
  '-c',
  'filter.workspace.smudge=',
  '--no-pager',
];

export interface WorkspaceGitOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Extra environment, for the two commands that need a private index. */
  env?: NodeJS.ProcessEnv;
  /** Standard input, written and then closed. Used by `hash-object --stdin`. */
  input?: Buffer | string;
  /** Maximum bytes of combined output before the rest is discarded. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Accept a non-zero exit instead of throwing, for the "does this exist" calls. */
  allowFailure?: boolean;
}

export interface WorkspaceGitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs one Git command and returns its raw bytes.
 *
 * Raw bytes rather than a string, because the same function is used to read file contents through
 * `cat-file blob` and a UTF-8 decode in the middle would silently replace anything that is not text.
 */
export async function runWorkspaceGit(
  args: readonly string[],
  options: WorkspaceGitOptions,
): Promise<WorkspaceGitResult> {
  const { cwd, signal } = options;
  signal?.throwIfAborted();
  const argv = [...MASKING_CONFIG, ...args];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return await new Promise<WorkspaceGitResult>((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd,
      env: workspaceGitEnvironment(options.env),
      // Never a shell: the whole point of an argument array is that nothing re-splits it.
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const errors: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Git command timed out: git ${args[0] ?? ''}`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(signal?.reason ?? new Error('Git command cancelled'));
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const kept = chunk.subarray(0, maxBytes - outBytes);
      out.push(kept);
      outBytes += kept.length;
      if (kept.length < chunk.length) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((total, entry) => total + entry.length, 0) < 64 * 1024) errors.push(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      const stderr = Buffer.concat(errors).toString('utf8');
      if (code !== 0 && !options.allowFailure) {
        const detail = stderr.trim() || `git exited with code ${code}`;
        reject(
          new WorkspaceGitError(
            `git ${args.slice(0, 3).join(' ')} failed: ${detail.slice(0, 2_000)}`,
            code,
            stderr,
          ),
        );
        return;
      }
      if (truncated) {
        reject(new Error(`Git output exceeded ${maxBytes} bytes: git ${args[0] ?? ''}`));
        return;
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr });
    });
    // A child that exits before the payload drains makes stdin report EPIPE, and an unhandled `error` event
    // on that socket is rethrown by Node as an uncaught exception that would take the Host down. The child's
    // own exit code and stderr below are the answer; a broken pipe adds nothing to it.
    child.stdin.on('error', () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** The same call, as trimmed UTF-8 text, for the commands whose output is a list of names or ids. */
export async function workspaceGit(
  args: readonly string[],
  options: WorkspaceGitOptions,
): Promise<string> {
  return (await runWorkspaceGit(args, options)).stdout.toString('utf8').trim();
}

/**
 * The records of a `-z` command, untrimmed.
 *
 * A file name may begin or end with whitespace, so the text a list is split from must not be trimmed: trimming
 * `workspaceGit` output would turn ` leading.txt` into a path that does not exist.
 */
export async function workspaceGitList(
  args: readonly string[],
  options: WorkspaceGitOptions,
): Promise<string[]> {
  return (await runWorkspaceGit(args, options)).stdout.toString('utf8').split('\0').filter(Boolean);
}

/** `git rev-parse` for one value, or null when Git does not answer. */
async function revParse(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runWorkspaceGit(['rev-parse', ...args], {
    cwd,
    ...(signal ? { signal } : {}),
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  const value = result.stdout.toString('utf8').trim();
  return value || null;
}

/**
 * What Git says a directory is: a working tree of which repository, and where that repository's shared metadata
 * lives.
 *
 * `repositoryRoot` is the *main* working tree, resolved through the shared metadata directory rather than guessed
 * from the path. That is the part that makes a linked worktree work: a child allocated from another child's
 * worktree still belongs to the same repository, and an allocation that only looked at `--show-toplevel` would
 * create a second, unrelated set of worktrees under a directory the main repository does not manage.
 */
export interface RepositoryIdentity {
  /** The directory Git was asked about, after resolving symlinks. */
  worktreeRoot: string;
  /** The working tree of the main repository: `<main>/.git` is a real directory. */
  repositoryRoot: string;
  /** This worktree's metadata directory (the shared one, for the main worktree). */
  metadataDirectory: string;
  /** The shared metadata directory, `<repositoryRoot>/.git`. */
  commonDirectory: string;
  /** Whether the directory asked about *is* the main working tree. */
  isMain: boolean;
  /** Git's object format for this repository, which decides how long an object id is. */
  objectFormat: 'sha1' | 'sha256';
}

export async function repositoryIdentity(
  directory: string,
  signal?: AbortSignal,
): Promise<RepositoryIdentity | null> {
  const worktreeRoot = await realpath(directory).catch(() => null);
  if (!worktreeRoot) return null;
  const inside = await revParse(worktreeRoot, ['--is-inside-work-tree'], signal);
  if (inside !== 'true') return null;
  const top = await revParse(worktreeRoot, ['--show-toplevel'], signal);
  const gitDir = await revParse(worktreeRoot, ['--absolute-git-dir'], signal);
  const commonDir = await revParse(worktreeRoot, ['--git-common-dir'], signal);
  if (!top || !gitDir || !commonDir) return null;
  const resolvedTop = await realpath(top).catch(() => null);
  const metadataDirectory = await realpath(gitDir).catch(() => null);
  if (!resolvedTop || !metadataDirectory) return null;
  const commonCandidate = path.isAbsolute(commonDir)
    ? commonDir
    : path.join(resolvedTop, commonDir);
  const commonDirectory = await realpath(commonCandidate).catch(() => null);
  if (!commonDirectory) return null;
  // The main working tree is the parent of the shared metadata directory — the one arrangement Git itself always
  // produces, which is why it is checked rather than assumed.
  const repositoryRoot = path.dirname(commonDirectory);
  const format = await revParse(worktreeRoot, ['--show-object-format'], signal);
  return {
    worktreeRoot: resolvedTop,
    repositoryRoot,
    metadataDirectory,
    commonDirectory,
    isMain: samePath(resolvedTop, repositoryRoot) && path.basename(commonDirectory) === '.git',
    objectFormat: format === 'sha256' ? 'sha256' : 'sha1',
  };
}

/**
 * Whether the repository is in a state a frozen baseline can be taken from.
 *
 * Each refusal names what this build cannot yet do, rather than proceeding and producing a baseline that quietly
 * omits part of the working tree. An unmerged index is the important one: the working file in that state may
 * contain conflict markers, and freezing those would hand a child a baseline that is not a state anybody chose.
 */
export interface RepositoryReadiness {
  head: string;
  /** The index file's own bytes, hashed. Evidence that the freeze did not rewrite it. */
  indexHash: string;
  hasSubmodules: boolean;
  sparse: boolean;
  unmerged: string[];
  bare: boolean;
}

export async function repositoryReadiness(
  identity: RepositoryIdentity,
  signal?: AbortSignal,
): Promise<RepositoryReadiness> {
  const cwd = identity.worktreeRoot;
  const options = signal ? { signal } : {};
  if ((await revParse(cwd, ['--is-bare-repository'], signal)) === 'true')
    throw new WorkspaceFailure(
      'WORKSPACE_NOT_A_REPOSITORY',
      'A bare repository has no working tree to copy',
    );
  const head = await revParse(cwd, ['--verify', 'HEAD^{commit}'], signal);
  if (!head)
    throw new WorkspaceFailure(
      'WORKSPACE_NO_HEAD',
      'The repository has no commit yet; make an initial commit before delegating write-capable work',
    );
  gitObjectId(head, 'head');
  // An unmerged index is detected through the index itself, with plumbing that runs no filters.
  const unmergedRecords = await workspaceGitList(['ls-files', '--unmerged', '-z'], {
    cwd,
    ...options,
  });
  const unmerged = [
    ...new Set(unmergedRecords.map((entry) => gitPath(entry.slice(entry.indexOf('\t') + 1)))),
  ].filter(Boolean);
  /**
   * A sparse checkout is read from the index rather than from configuration.
   *
   * `git ls-files -t` marks a path the sparse patterns exclude with `S`, and that mark is the answer to the
   * question actually being asked — "is part of this working tree absent by design" — while `core.sparseCheckout`
   * only says a mechanism is configured. A cone-mode checkout that currently excludes nothing is not a reason to
   * refuse, and a tree with holes in it is.
   */
  const sparseMarks = (
    await workspaceGitList(['ls-files', '-t', '-z'], { cwd, ...options, allowFailure: true })
  ).filter((entry) => entry.startsWith('S '));
  return {
    head,
    indexHash: await hashFile(path.join(identity.metadataDirectory, 'index')),
    /**
     * Submodules are refused rather than copied: a gitlink names another repository, so a baseline containing one
     * describes a tree this service cannot reproduce. `.gitmodules` is the declaration that survives even when
     * no gitlink is currently checked out.
     */
    hasSubmodules: (await readGitmodules(identity.worktreeRoot)) !== null,
    sparse: sparseMarks.length > 0,
    unmerged,
    bare: false,
  };
}

async function readGitmodules(root: string): Promise<string | null> {
  return await readFile(path.join(root, '.gitmodules'), 'utf8').catch(() => null);
}

/**
 * Hashes a file's bytes, or returns a constant for a file that does not exist.
 *
 * Used for the private evidence that the freeze did not touch the user's index: comparing the hash before and
 * after is the only way to show that a `write-tree` did not stage anything into the user's own index, and a
 * missing index (a freshly initialised repository) is a state with its own constant rather than an error.
 */
async function hashFile(file: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) return 'absent';
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * One write lock per repository, for the metadata operations that cannot overlap.
 *
 * Git's own index and lock files make two concurrent `worktree add` calls fail rather than corrupt anything, so
 * this is not about safety so much as about a delegated fan-out being *usable*: without it, four children of one
 * call race for one lock file and three of them fail for a reason that has nothing to do with the work. The lock
 * covers only this service's metadata operations — a child's ordinary file writes never take it.
 */
const repositoryLocks = new Map<string, Promise<unknown>>();

export async function withRepositoryLock<T>(
  repositoryRoot: string,
  body: () => Promise<T>,
): Promise<T> {
  const key = canonicalKey(repositoryRoot);
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  repositoryLocks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await body();
  } finally {
    release();
    // Only the tail clears the entry, so a later caller still queues behind whatever replaced it.
    if (repositoryLocks.get(key) === queued) repositoryLocks.delete(key);
  }
}

/**
 * The managed directory layout: `<worktree home>/<repository key>/<id>` (`../platform/worktree-home.ts`).
 *
 * Outside the repository and off every protected path component, so a write-capable child confined by a native
 * sandbox to its own worktree can write there, and the delegator's sandbox — rooted at the repository — cannot reach
 * into it. The id is generated by the service: a model-supplied task name must never be a path.
 */
export function managedWorktreeRoot(repositoryRoot: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    throw new WorkspaceFailure(
      'WORKSPACE_INTEGRITY',
      'Invalid workspace identifier for a directory name',
    );
  return path.join(repositoryWorktreeParent(repositoryRoot), id);
}

/**
 * The layout earlier versions allocated into, `<repository>/.yuantu/worktrees/<id>`.
 *
 * Still recognised so a binding recorded before the move can be validated, archived, removed and recovered; nothing
 * new is allocated there.
 */
function legacyWorktreeParent(repositoryRoot: string): string {
  return path.join(repositoryRoot, '.yuantu', 'worktrees');
}

/** Whether `target` is exactly one directory below `parent`. */
function directChild(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return !relative.includes(path.sep);
}

/**
 * Whether a directory is one this service's layout says it may own.
 *
 * Checked before anything is created or removed, so a recursive removal can never be aimed at an arbitrary
 * database path: the directory has to be a direct child of the parent this repository's key names under the
 * worktree home — or of the legacy in-repository parent — for the repository the caller proved it belongs to.
 */
export function isManagedWorktreePath(repositoryRoot: string, target: string): boolean {
  return (
    directChild(repositoryWorktreeParent(repositoryRoot), target) ||
    directChild(legacyWorktreeParent(repositoryRoot), target)
  );
}

/** The parents a repository's managed worktrees may live in, current layout first. */
export function managedWorktreeParents(repositoryRoot: string): string[] {
  return [repositoryWorktreeParent(repositoryRoot), legacyWorktreeParent(repositoryRoot)];
}

/**
 * Git's own record of a worktree, read back out of `git worktree list --porcelain`.
 *
 * The reverse link is the point: a directory that merely *looks* like a managed worktree is not one, and the only
 * authority on whether Git registered it is Git. `HEAD` and `branch` come along because a caller that verifies an
 * allocation wants to see both the commit and the fact that no branch was taken.
 */
export interface RegisteredWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function registeredWorktrees(
  identity: RepositoryIdentity,
  signal?: AbortSignal,
): Promise<RegisteredWorktree[]> {
  const output = await workspaceGit(['worktree', 'list', '--porcelain'], {
    cwd: identity.worktreeRoot,
    ...(signal ? { signal } : {}),
  });
  const found: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) found.push(current);
      current = {
        path: line.slice('worktree '.length).trim(),
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim();
    else if (line.trim() === 'detached') current.detached = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) found.push(current);
  return found;
}

/**
 * The relative path of this worktree's metadata inside the main repository's `.git`, or null when the directory
 * is not a linked worktree of it.
 *
 * `<main>/.git/worktrees/<name>` is the only shape Git registers, and a `.git` **file** (rather than a directory)
 * is what marks a linked worktree. Both halves are checked, because either alone is easy to forge: a directory
 * with a hand-written `.git` file would otherwise pass as one of ours.
 */
export async function linkedWorktreeName(
  identity: RepositoryIdentity,
  target: string,
): Promise<string | null> {
  const dotGit = path.join(target, '.git');
  const info = await lstat(dotGit).catch(() => null);
  if (!info?.isFile()) return null;
  const pointer = (await readFile(dotGit, 'utf8').catch(() => '')).trim();
  if (!pointer.toLowerCase().startsWith('gitdir:')) return null;
  const metadata = path.resolve(target, pointer.slice('gitdir:'.length).trim());
  const worktrees = path.join(identity.commonDirectory, 'worktrees');
  const relative = path.relative(worktrees, metadata);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  )
    return null;
  // The reverse link, resolved through the filesystem: Git writes this exact path back, and a mismatch means the
  // metadata belongs to a different directory than the one being asked about.
  const reverse = (await readFile(path.join(metadata, 'gitdir'), 'utf8').catch(() => '')).trim();
  if (!reverse) return null;
  const back = await realpath(path.resolve(metadata, reverse)).catch(() => null);
  const here = await realpath(dotGit).catch(() => null);
  if (!back || !here || !samePath(back, here)) return null;
  return relative;
}

/**
 * Writes a file only if the bytes are not already there, creating parents.
 *
 * Populating a worktree writes hundreds of files, and the ones a `--no-checkout` registration already left in
 * place are the common case for a clean tree: rewriting them would touch modification times for no reason and make
 * a build system redo work the snapshot did not change.
 */
export async function writeFileExact(
  target: string,
  bytes: Buffer,
  options: { ifAbsent?: boolean } = {},
): Promise<'written' | 'unchanged'> {
  const existing = await readFile(target).catch(() => null);
  if (existing && existing.equals(bytes)) return 'unchanged';
  if (existing && options.ifAbsent) return 'unchanged';
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return 'written';
}

/** Whether a path is a plain file, refusing the directory, symlink and special entries this version cannot copy. */
export async function plainFileInfo(
  target: string,
): Promise<{ ok: true; size: number; mode: number } | { ok: false; reason: string }> {
  const info = await lstat(target).catch(() => null);
  if (!info) return { ok: false, reason: 'missing' };
  if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (info.isDirectory()) return { ok: false, reason: 'directory' };
  if (!info.isFile()) return { ok: false, reason: 'special' };
  return { ok: true, size: info.size, mode: info.mode };
}

export async function pathExists(target: string): Promise<boolean> {
  return await stat(target)
    .then(() => true)
    .catch(() => false);
}

/**
 * Many blobs through one `git fast-import`, with their ids answered in the order they were added.
 *
 * `hash-object -w` writes one loose object file per blob, and on Windows creating that file (and its fan-out
 * directory) costs milliseconds each; one `hash-object` process per blob costs tens more. A 2000-file tree took
 * about 15 s through `--stdin-paths` and 72 s through one process per file. `fast-import` streams every blob into
 * one pack (a small batch is exploded into loose objects by Git itself, per `fastimport.unpackLimit`) and runs no
 * filter, hook or attribute lookup, so the stored bytes are exactly the bytes given. The ids come back on standard
 * output through `get-mark`, so nothing is written beside the repository to read them.
 *
 * Bytes are written as they are added and the stream honours back-pressure, so a caller walking a tree holds one
 * file at a time, as it did with one process per file.
 */
export interface BlobBatch {
  add(bytes: Buffer): Promise<void>;
  /** Closes the stream and answers one id per `add`, in order. */
  finish(): Promise<string[]>;
  /** Ends the process without answering; for a caller whose own work failed. */
  abort(): void;
}

export function openBlobBatch(repositoryRoot: string, signal?: AbortSignal): BlobBatch {
  signal?.throwIfAborted();
  const child = spawn('git', [...MASKING_CONFIG, 'fast-import', '--quiet', '--done'], {
    cwd: repositoryRoot,
    env: workspaceGitEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const errors: Buffer[] = [];
  let failure: Error | undefined;
  let count = 0;
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    if (errors.reduce((total, entry) => total + entry.length, 0) < 64 * 1024) errors.push(chunk);
  });
  // As in `runWorkspaceGit`: a child that exits early makes stdin report EPIPE, and the exit code is the answer.
  child.stdin.on('error', () => {});
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      failure ??= error;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
  const stop = () => {
    failure ??=
      signal?.reason instanceof Error ? signal.reason : new Error('Git command cancelled');
    child.kill();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const write = async (chunk: Buffer | string) => {
    if (failure) throw failure;
    if (!child.stdin.write(chunk))
      await new Promise<void>((resolve) => {
        const done = () => {
          child.stdin.off('drain', done);
          child.off('close', done);
          resolve();
        };
        child.stdin.once('drain', done);
        child.once('close', done);
      });
    if (failure) throw failure;
  };
  return {
    async add(bytes) {
      count++;
      await write(`blob\nmark :${count}\ndata ${bytes.length}\n`);
      await write(bytes);
      await write('\n');
    },
    async finish() {
      let requests = '';
      for (let mark = 1; mark <= count; mark++) requests += `get-mark :${mark}\n`;
      await write(`${requests}done\n`);
      child.stdin.end();
      const timer = setTimeout(stop, DEFAULT_TIMEOUT_MS);
      const code = await closed;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure) throw failure;
      if (code !== 0) {
        const detail =
          Buffer.concat(errors).toString('utf8').trim() || `git exited with code ${code}`;
        throw new WorkspaceGitError(
          `git fast-import failed: ${detail.slice(0, 2_000)}`,
          code,
          detail,
        );
      }
      const ids = Buffer.concat(out)
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (ids.length !== count || !ids.every((id) => /^[0-9a-f]{40,64}$/.test(id)))
        throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not write every blob');
      return ids;
    },
    abort() {
      signal?.removeEventListener('abort', stop);
      failure ??= new Error('Blob batch abandoned');
      child.kill();
    },
  };
}

/** Writes every buffer as a blob in one process; see {@link openBlobBatch}. */
export async function writeBlobs(
  repositoryRoot: string,
  sources: AsyncIterable<Buffer> | Iterable<Buffer>,
  signal?: AbortSignal,
): Promise<string[]> {
  const batch = openBlobBatch(repositoryRoot, signal);
  try {
    for await (const bytes of sources) await batch.add(bytes);
  } catch (error) {
    batch.abort();
    throw error;
  }
  return await batch.finish();
}

/** Blobs read back through one `cat-file --batch` process; see {@link openBlobReader}. */
export interface BlobReader {
  /** The blob's bytes, or `null` when the repository does not have it. */
  read(objectId: string): Promise<Buffer | null>;
  close(): void;
}

/**
 * Reads many blobs through one Git process.
 *
 * A snapshot's bytes live only in the object store, so filling a worktree reads one blob per file; a `cat-file`
 * process per blob costs tens of milliseconds each on Windows, which is the same arithmetic that made the freeze
 * write through one `fast-import`. Requests are answered in order, so they are queued and each waits for the one
 * before it. Raw bytes: `--batch` applies no filter, textconv or line-ending conversion.
 */
export function openBlobReader(repositoryRoot: string, signal?: AbortSignal): BlobReader {
  signal?.throwIfAborted();
  const child = spawn('git', [...MASKING_CONFIG, 'cat-file', '--batch'], {
    cwd: repositoryRoot,
    env: workspaceGitEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffered: Buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  const waiting: { resolve: (bytes: Buffer | null) => void; reject: (error: Error) => void }[] = [];
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of waiting.splice(0)) request.reject(failure);
  };
  const drain = () => {
    for (;;) {
      const request = waiting[0];
      if (!request) return;
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const header = buffered.subarray(0, newline).toString('utf8');
      if (header.endsWith(' missing')) {
        buffered = buffered.subarray(newline + 1);
        waiting.shift();
        request.resolve(null);
        continue;
      }
      const match = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(header);
      if (!match) return fail(new Error(`Unexpected cat-file answer: ${header.slice(0, 200)}`));
      const size = Number(match[2]);
      // The object, then one newline.
      if (buffered.length < newline + 1 + size + 1) return;
      const bytes = Buffer.from(buffered.subarray(newline + 1, newline + 1 + size));
      buffered = buffered.subarray(newline + 1 + size + 1);
      waiting.shift();
      request.resolve(match[1] === 'blob' ? bytes : null);
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    drain();
  });
  child.stdin.on('error', () => {});
  child.once('error', (error) => fail(error));
  child.once('close', () => fail(new Error('Git blob reader closed')));
  const abort = () =>
    fail(signal?.reason instanceof Error ? signal.reason : new Error('Git command cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  return {
    read(objectId) {
      if (!/^[0-9a-f]{40,64}$/.test(objectId))
        return Promise.reject(new Error('Invalid object id'));
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        child.stdin.write(`${objectId}\n`);
      });
    },
    close() {
      signal?.removeEventListener('abort', abort);
      child.stdin.end();
      child.kill();
    },
  };
}

/** Reads one object back as bytes, with no filter or textconv in the way. */
export async function readBlob(
  repositoryRoot: string,
  objectId: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const result = await runWorkspaceGit(['cat-file', 'blob', objectId], {
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755';
  /** The blob, when the caller already has one; otherwise `bytes` is written and becomes the blob. */
  blob?: string;
  bytes?: Buffer;
}

/**
 * Builds a tree object from a flat path list, writing whatever blobs it does not already have.
 *
 * The recursion is over path *segments*, which is what Git's object model requires: a tree holds entries for its
 * immediate children, and a directory is a subtree rather than a prefix on a name. `mktree` takes each directory's
 * entries on standard input, so a whole tree costs one process per directory instead of one `add` per file — and
 * no index is involved anywhere, so nothing here can touch the user's index even by accident.
 */
export async function writeTree(
  repositoryRoot: string,
  entries: readonly TreeEntry[],
  signal?: AbortSignal,
  trees?: TreeIdCache,
): Promise<string> {
  const root: TreeNode = { files: [], directories: new Map() };
  // Entries that arrive with bytes rather than an id share one blob stream instead of one process each.
  const pending = entries.filter((entry) => entry.blob === undefined);
  const written = pending.length
    ? await writeBlobs(
        repositoryRoot,
        pending.map((entry) => entry.bytes ?? Buffer.alloc(0)),
        signal,
      )
    : [];
  const ids = new Map(pending.map((entry, index) => [entry, written[index]!]));
  for (const entry of entries) {
    const segments = entry.path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.directories.get(segment);
      if (!next) {
        next = { files: [], directories: new Map() };
        node.directories.set(segment, next);
      }
      node = next;
    }
    const name = segments[segments.length - 1]!;
    const blob = entry.blob ?? ids.get(entry)!;
    node.files.push({ name, mode: entry.mode, blob });
  }
  return await materializeTree(repositoryRoot, root, signal, trees);
}

/**
 * Tree ids already written, keyed by the listing they were written from.
 *
 * `writeTree` spawns one `git mktree` per directory, in sequence — thousands of processes for a large repository,
 * every time a worktree child's turn is exported, although a turn usually changes one or two directories. A
 * directory whose listing is unchanged is the same tree, so its id is reused without a process. The bound keeps a
 * long-lived Host from holding one entry per directory it has ever seen.
 */
export class TreeIdCache {
  private readonly ids = new Map<string, string>();
  private readonly limit: number;
  constructor(limit = 50_000) {
    this.limit = limit;
  }
  get(listing: string): string | undefined {
    return this.ids.get(listing);
  }
  set(listing: string, tree: string): void {
    if (this.ids.size >= this.limit) this.ids.clear();
    this.ids.set(listing, tree);
  }
  clear(): void {
    this.ids.clear();
  }
}

interface TreeNode {
  files: { name: string; mode: '100644' | '100755'; blob: string }[];
  directories: Map<string, TreeNode>;
}

async function materializeTree(
  repositoryRoot: string,
  node: TreeNode,
  signal?: AbortSignal,
  trees?: TreeIdCache,
): Promise<string> {
  const lines: string[] = [];
  for (const file of node.files) lines.push(`${file.mode} blob ${file.blob}\t${file.name}`);
  for (const [name, child] of node.directories)
    lines.push(
      `040000 tree ${await materializeTree(repositoryRoot, child, signal, trees)}\t${name}`,
    );
  // Sorted by name, which is the order Git writes its own tree objects in and what makes a tree id a function of
  // its contents rather than of the order a walk happened to produce them.
  lines.sort((left, right) => {
    const a = left.slice(left.indexOf('\t') + 1);
    const b = right.slice(right.indexOf('\t') + 1);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const input = `${lines.join('\0')}\0`;
  const known = trees?.get(input);
  if (known) return known;
  // `-z`: each record ends in NUL and its name is taken verbatim, so a newline or a leading quote is just a name.
  const output = await runWorkspaceGit(['mktree', '-z'], {
    cwd: repositoryRoot,
    input,
    ...(signal ? { signal } : {}),
  });
  const tree = output.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not write a tree');
  trees?.set(input, tree);
  return tree;
}

/**
 * One path that differs between two trees, with the object on each side.
 *
 * `diff-tree -r --raw -z --no-renames` is plumbing: no external diff, no textconv, no rename detection (a rename
 * is reported as a delete and a create, which is exactly the two-path accounting the journal needs, and exactly
 * what a reader who greps the change list for a path needs to find), and no pager.
 */
export interface TreeDifference {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'mode';
  beforeBlob: string | null;
  afterBlob: string | null;
  beforeMode: string | null;
  afterMode: string | null;
}
export async function diffTrees(
  repositoryRoot: string,
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<TreeDifference[]> {
  if (before === after) return [];
  const output = await runWorkspaceGit(
    ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-commit-id', before, after],
    { cwd: repositoryRoot, ...(signal ? { signal } : {}), maxBytes: 64 * 1024 * 1024 },
  );
  const fields = output.stdout.toString('utf8').split('\0');
  const found: TreeDifference[] = [];
  for (let index = 0; index < fields.length; index++) {
    const header = fields[index]!;
    // `:<old mode> <new mode> <old sha> <new sha> <status>`, followed by the path as its own NUL-terminated field,
    // which is why the path comes from the next field rather than from the header.
    if (!header.startsWith(':')) continue;
    const parts = header.slice(1).trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [beforeMode, afterMode, beforeBlob, afterBlob] = parts as [
      string,
      string,
      string,
      string,
    ];
    const path = gitPath(fields[++index] ?? '');
    if (!path) continue;
    const zero = /^0+$/.test(beforeBlob);
    const gone = /^0+$/.test(afterBlob);
    found.push({
      path,
      status: zero ? 'added' : gone ? 'deleted' : beforeMode !== afterMode ? 'mode' : 'modified',
      beforeBlob: zero ? null : beforeBlob,
      afterBlob: gone ? null : afterBlob,
      beforeMode: zero ? null : beforeMode,
      afterMode: gone ? null : afterMode,
    });
  }
  return found;
}

export { isUnsafeGitPath, gitPath };
