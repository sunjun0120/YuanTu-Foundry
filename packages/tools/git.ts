import { resolveSandboxConfig } from '../sandbox/sandbox.ts';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import type { PreparedTool, Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import { bounded, MAX_TOOL_OUTPUT } from './registry.ts';
import { killTree } from '../platform/process-tree.ts';
import { localExecutionEnvironment } from './execution-environment.ts';
import { currentExecutionPolicy, executionPolicy } from '../sandbox/execution-policy.ts';
import { samePath } from '../platform/workspace-paths.ts';
import { repositoryWorktreeParent } from '../platform/worktree-home.ts';
import {
  nativeGitWrites,
  nativeGitExecutable,
  nativeGitIdentityQuery,
  prepareNativeGitWrite,
  type GitInvocation,
} from './git-native-write.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

const GIT_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = MAX_TOOL_OUTPUT * 2;
const MAX_COMMIT_MESSAGE = 8_000;
const schema = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

/**
 * `includeGlobal` is only for read-only `git config` queries that must see the
 * user's real identity (user.name/user.email/commit.gpgsign). Every mutating
 * command keeps the global config masked so a stray `core.hooksPath`,
 * `commit.gpgsign` or alias cannot change what the agent actually runs.
 */
function gitEnvironment(includeGlobal = false): NodeJS.ProcessEnv {
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
  if (!includeGlobal) env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.LC_ALL = 'C';
  if (includeGlobal) {
    for (const name of [
      'HOME',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'XDG_CONFIG_HOME',
      'GIT_CONFIG_GLOBAL',
    ])
      if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/**
 * `safeDirectory` defaults to the directory we are already operating in, which
 * `repositoryRoot` has proven to be inside the user-chosen workspace. Git's
 * ownership guard would otherwise reject workspaces whose repository was
 * created by another account, and masking the global config also hides any
 * `safe.directory` exception the user configured there.
 */
export function gitCommandLine(safeDirectory: string): string[] {
  return [
    '-c',
    `safe.directory=${safeDirectory.replace(/\\/g, '/')}`,
    '-c',
    'color.ui=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.external=',
    '-c',
    'diff.trustExitCode=false',
    '--no-pager',
  ];
}

class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly truncated: boolean;
  constructor(message: string, exitCode: number | null, truncated = false) {
    super(message);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.truncated = truncated;
  }
}

async function captureGit(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  options: { includeGlobal?: boolean; safeDirectory?: string; invocation?: GitInvocation } = {},
): Promise<{ content: string; truncated: boolean }> {
  signal.throwIfAborted();
  const config = resolveSandboxConfig();
  const argv = [...gitCommandLine(options.safeDirectory ?? root), ...args];
  const program =
    config.mode === 'host' || options.invocation ? 'git' : await nativeGitExecutable(root);
  const managed =
    config.mode === 'host' || options.invocation
      ? undefined
      : await (
          await localExecutionEnvironment(
            root,
            currentExecutionPolicy() ?? executionPolicy(config.mode, config),
          )
        ).processes.start(program, argv, '.', signal, gitEnvironment(false));
  return new Promise((resolve, reject) => {
    const child =
      managed?.child ??
      spawn(options.invocation?.executable ?? 'git', options.invocation?.args ?? argv, {
        cwd: root,
        env: options.invocation?.env ?? gitEnvironment(options.includeGlobal === true),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killing: Promise<void> | undefined;
    const collect = (chunk: Buffer) => {
      if (captured >= MAX_CAPTURE_BYTES) {
        truncated = true;
        return;
      }
      const kept = chunk.subarray(0, MAX_CAPTURE_BYTES - captured);
      chunks.push(kept);
      captured += kept.length;
      if (kept.length < chunk.length) truncated = true;
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    const stop = () => {
      if (child.pid && !killing)
        killing = managed
          ? managed.stop()
          : killTree(child.pid).catch(() => {
              child.kill();
            });
      void killing?.catch(() => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, GIT_TIMEOUT_MS);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        if (killing) await killing;
        if (managed) await managed.closed;
        if (spawnError) throw spawnError;
        if (signal.aborted) return reject(signal.reason);
        // Keep the capture intact. The registry spills it and reports whether it is partial.
        const output = Buffer.concat(chunks).toString('utf8');
        if (timedOut) return reject(new Error(`Git command timed out after ${GIT_TIMEOUT_MS}ms`));
        if (code !== 0)
          return reject(
            new GitCommandError(output || `git exited with code ${code}`, code, truncated),
          );
        resolve({ content: output, truncated });
      })().catch(reject);
    });
  });
}

/** Internal metadata queries and mutation summaries retain their string interface. */
async function git(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  options: { includeGlobal?: boolean; safeDirectory?: string } = {},
): Promise<string> {
  const output = await captureGit(root, args, signal, options);
  return output.content + (output.truncated ? '\n[output truncated]' : '');
}

async function readGit(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  empty: string,
  trim = true,
): Promise<ToolResult> {
  try {
    const output = await captureGit(root, args, signal);
    return {
      isError: false,
      content: (trim && !output.truncated ? output.content.trim() : output.content) || empty,
      ...(output.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    return {
      isError: true,
      content: error.message,
      ...(error.truncated ? { truncated: true } : {}),
    };
  }
}

/** Mutation failures must preserve partial-capture metadata through the registry's error boundary too. */
function withGitErrors(prepared: PreparedTool): PreparedTool {
  return {
    ...prepared,
    async execute(context) {
      try {
        return await prepared.execute(context);
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error;
        return {
          isError: true,
          content: error.message,
          ...(error.truncated ? { truncated: true } : {}),
        };
      }
    },
  };
}

function contained(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

/**
 * The repository that owns a delegated child's worktree, derived from the worktree's *location* rather than from
 * anything the worktree's own `.git` file says.
 *
 * Two layouts: the current one under the worktree home (`<home>/<key>/<id>`), where the owner is the repository
 * whose metadata directory holds the link *and* whose key names the worktree's parent; and the legacy one inside the
 * owner (`<owner>/.yuantu/worktrees/<id>`).
 */
function worktreeOwner(repository: string, metadata: string): string | null {
  const worktrees = path.dirname(repository);
  const state = path.dirname(worktrees);
  if (path.basename(worktrees) === 'worktrees' && path.basename(state) === '.yuantu')
    return path.dirname(state);
  // `<owner>/.git/worktrees/<name>`: the candidate owner is read off the metadata path, then has to be the
  // repository whose key the worktree's parent is named after — a crafted `.git` file cannot choose both.
  const commonWorktrees = path.dirname(metadata);
  const common = path.dirname(commonWorktrees);
  if (path.basename(commonWorktrees) !== 'worktrees' || path.basename(common) !== '.git')
    return null;
  const owner = path.dirname(common);
  return samePath(path.dirname(repository), repositoryWorktreeParent(owner)) ? owner : null;
}

async function managedWorktreeMetadata(repository: string, metadata: string): Promise<boolean> {
  const owner = worktreeOwner(repository, metadata);
  if (!owner) return false;
  try {
    const commonWorktrees = await realpath(path.join(owner, '.git', 'worktrees'));
    if (!contained(commonWorktrees, metadata) || commonWorktrees === metadata) return false;
    // A matching directory name is not enough: Git's reverse link must point back to this exact
    // worktree, or a crafted .git file could gain access to unrelated repository metadata.
    const reverse = (await readFile(path.join(metadata, 'gitdir'), 'utf8')).trim();
    return (
      (await realpath(path.resolve(metadata, reverse))) ===
      (await realpath(path.join(repository, '.git')))
    );
  } catch {
    return false;
  }
}

async function repositoryRoot(root: string, signal: AbortSignal, writing = false): Promise<string> {
  const workspace = await realpath(root);
  // Discovery has to precede the containment proof, so it cannot name the
  // repository as safe yet. Both calls are read-only ref lookups that run no
  // repository-controlled program; every later call uses the proven path.
  const top = (
    await git(workspace, ['rev-parse', '--show-toplevel'], signal, { safeDirectory: '*' })
  ).trim();
  const gitDirectory = (
    await git(workspace, ['rev-parse', '--absolute-git-dir'], signal, { safeDirectory: '*' })
  ).trim();
  const repository = await realpath(top);
  const metadata = await realpath(gitDirectory);
  if (writing && resolveSandboxConfig().mode !== 'host' && !samePath(workspace, repository))
    throw new Error('Controlled Git writes require the selected repository root as the workspace');
  /*
   * A workspace that is a *subdirectory* of a repository is ordinary (a monorepo package, `projects/<name>`),
   * and refusing it silently made `git_diff` an English dead end: "must be contained in the workspace" says
   * neither why nor what to do. The refusal itself stays — the repository's metadata is outside the workspace,
   * and trusting a `.git` the workspace does not contain is exactly the escape this proof exists to stop — but
   * the message now names the situation and the two ways forward.
   */
  const outsideWorkspace = `this workspace is inside the repository at ${repository}, and Git metadata (${metadata}) is outside the workspace`;
  const remedy =
    'Use the repository root as the workspace to read Git state, or read the files directly without the Git tools.';
  if (!contained(workspace, repository))
    throw new Error(
      `Git tools need the repository root inside the workspace: ${outsideWorkspace}. ${remedy}`,
    );
  if (!contained(workspace, metadata) && !(await managedWorktreeMetadata(repository, metadata)))
    throw new Error(
      `Git tools need the repository metadata inside the workspace: ${outsideWorkspace}. ${remedy}`,
    );
  return repository;
}

function safePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((input) => {
    if (input.includes('\0') || path.isAbsolute(input) || input.startsWith(':'))
      throw new Error('Invalid Git path');
    const normalized = input.replace(/\\/g, '/');
    if (normalized.split('/').some((part) => part === '..'))
      throw new Error('Git paths must stay inside the repository');
    return normalized;
  });
}

/** Read one config value, treating "unset" (exit 1) as an empty string. */
async function gitConfig(
  root: string,
  key: string,
  signal: AbortSignal,
  asBool = false,
): Promise<string> {
  try {
    if (resolveSandboxConfig().mode !== 'host') {
      const invocation = await nativeGitIdentityQuery(root, key, asBool, gitEnvironment(true));
      return (await captureGit(root, [], signal, { invocation })).content.trim();
    }
    return (
      await git(root, ['config', '--get', ...(asBool ? ['--bool'] : []), key], signal, {
        includeGlobal: true,
      })
    ).trim();
  } catch {
    signal.throwIfAborted();
    return '';
  }
}
function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 20).join(', ');
  return paths.length > 20 ? `${shown}, +${paths.length - 20} more` : shown;
}
function commitMessage(value: unknown): string {
  const message = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!message) throw new Error('Commit message must not be empty');
  if (message.length > MAX_COMMIT_MESSAGE)
    throw new Error(`Commit message must be at most ${MAX_COMMIT_MESSAGE} characters`);
  if (message.includes('\0')) throw new Error('Commit message must not contain NUL');
  return message;
}
async function stagedPaths(repository: string, signal: AbortSignal): Promise<string[]> {
  const output = await git(repository, ['diff', '--cached', '--name-only', '-z'], signal);
  return output.split('\0').filter(Boolean);
}
/** Identity and signing must be resolved before approval so the gate shows the real intent. */
async function commitPreconditions(
  repository: string,
  signal: AbortSignal,
): Promise<{ name: string; email: string }> {
  const name = await gitConfig(repository, 'user.name', signal);
  const email = await gitConfig(repository, 'user.email', signal);
  if (!name || !email)
    throw new Error(
      'Git author identity is not configured; set user.name and user.email in Git config before committing',
    );
  if ((await gitConfig(repository, 'commit.gpgsign', signal, true)) === 'true')
    throw new Error(
      'This repository enables commit.gpgsign and the agent cannot sign non-interactively; commit manually or disable commit.gpgsign',
    );
  return { name, email };
}

async function prepareStage(
  root: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const native = nativeGitWrites();
  const repository = await repositoryRoot(root, context.signal, true);
  const paths = safePaths(args.paths);
  if (!paths.length) throw new Error('paths must list at least one repository-relative path');
  const unstage = args.unstage === true;
  const broker = native
    ? await prepareNativeGitWrite(
        repository,
        { kind: 'stage', paths, unstage },
        (argv, signal) => git(repository, argv, signal),
        context.signal,
      )
    : undefined;
  return withGitErrors({
    ...(native
      ? {
          approvalIsolation:
            'Isolation: controlled local Git metadata operation on the Host; repository programs and remote protocols are disabled. Ordinary commands remain sandboxed.',
        }
      : {}),
    approvalDescription: [
      `${unstage ? 'Unstage' : 'Stage'} ${paths.length} path(s): ${describePaths(paths)}`,
      unstage ? 'Runs: git reset -q HEAD -- <paths>' : 'Runs: git add -- <paths>',
      ...(native
        ? [
            'Controlled Host Git metadata operation; hooks are disabled. Staging refuses repositories with configured filters.',
          ]
        : []),
    ].join('\n'),
    async execute(ctx: ToolContext) {
      // `git restore --staged` cannot run before the first commit; `git reset` can.
      const output = broker
        ? (
            await broker.execute(
              (invocation, signal) => captureGit(repository, [], signal, { invocation }),
              gitEnvironment(),
              ctx.signal,
            )
          ).content
        : await git(
            repository,
            unstage ? ['reset', '-q', 'HEAD', '--', ...paths] : ['add', '--', ...paths],
            ctx.signal,
          );
      const staged = await stagedPaths(repository, ctx.signal);
      return {
        isError: false,
        content: bounded(
          [
            output.trim() || (unstage ? 'Unstaged' : 'Staged'),
            staged.length
              ? `Staged now (${staged.length}): ${describePaths(staged)}`
              : 'Nothing is staged.',
          ].join('\n'),
        ),
      };
    },
  });
}

async function prepareCommit(
  root: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const native = nativeGitWrites();
  const repository = await repositoryRoot(root, context.signal, true);
  const message = commitMessage(args.message);
  const staged = await stagedPaths(repository, context.signal);
  if (!staged.length) throw new Error('Nothing is staged; run git_stage before git_commit');
  const identity = await commitPreconditions(repository, context.signal);
  const noVerify = args.no_verify === true;
  const broker = native
    ? await prepareNativeGitWrite(
        repository,
        { kind: 'commit', message, identity },
        (argv, signal) => git(repository, argv, signal),
        context.signal,
      )
    : undefined;
  return withGitErrors({
    ...(native
      ? {
          approvalIsolation:
            'Isolation: controlled local Git metadata operation on the Host; repository programs and remote protocols are disabled. Ordinary commands remain sandboxed.',
        }
      : {}),
    approvalDescription: [
      `Commit ${staged.length} staged file(s) as ${identity.name} <${identity.email}>: ${describePaths(staged)}`,
      `Message:\n${message}`,
      native
        ? 'Controlled Host Git metadata operation; repository hooks and filters are disabled. The approved index and HEAD are checked before updating the reference.'
        : noVerify
          ? 'WARNING: no_verify is set, so repository hooks will be skipped.'
          : 'Repository hooks will run; they may execute repository-controlled programs.',
    ].join('\n'),
    async execute(ctx: ToolContext) {
      const output = broker
        ? (
            await broker.execute(
              (invocation, signal) => captureGit(repository, [], signal, { invocation }),
              gitEnvironment(),
              ctx.signal,
            )
          ).content
        : await git(
            repository,
            [
              '-c',
              `user.name=${identity.name}`,
              '-c',
              `user.email=${identity.email}`,
              'commit',
              '-m',
              message,
              ...(noVerify ? ['--no-verify'] : []),
            ],
            ctx.signal,
          );
      const head = (await git(repository, ['rev-parse', 'HEAD'], ctx.signal)).trim();
      return {
        isError: false,
        content: bounded(`${output.trim() || 'Committed'}\nHEAD is now ${head}`),
      };
    },
  });
}

const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
async function worktreeParent(repository: string, create: boolean): Promise<string> {
  let current = repository;
  for (const component of ['.yuantu', 'worktrees']) {
    const next = path.join(current, component);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Worktree parent must be a real directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (create) await mkdir(next);
    }
    current = next;
  }
  if (create && !contained(repository, await realpath(current)))
    throw new Error('Worktree parent must stay inside the workspace');
  return current;
}
async function prepareWorktreeCreate(
  root: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const native = nativeGitWrites();
  const repository = await repositoryRoot(root, context.signal, true);
  if (
    repository !== (await realpath(root)) ||
    !(await lstat(path.join(repository, '.git'))).isDirectory()
  )
    throw new Error('Create managed worktrees from the primary repository root');
  const branch = String(args.branch ?? '');
  const name = String(args.name ?? '');
  if (!WORKTREE_NAME.test(name)) throw new Error('Invalid worktree name');
  if (!branch || branch.length > 128 || branch.startsWith('-'))
    throw new Error('Invalid branch name');
  await git(repository, ['check-ref-format', '--branch', branch], context.signal);
  const target = path.join(await worktreeParent(repository, false), name);
  try {
    await lstat(target);
    throw new Error('Worktree target already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const broker = native
    ? await prepareNativeGitWrite(
        repository,
        { kind: 'worktree', branch, target },
        (argv, signal) => git(repository, argv, signal),
        context.signal,
      )
    : undefined;
  return withGitErrors({
    ...(native
      ? {
          approvalIsolation:
            'Isolation: controlled local Git metadata operation on the Host; repository programs and remote protocols are disabled. Ordinary commands remain sandboxed.',
        }
      : {}),
    approvalDescription:
      `Create branch ${branch} from HEAD and check it out at ${target}.` +
      '\nThe current worktree and its uncommitted changes stay in place.' +
      (native
        ? ' Controlled Host Git metadata operation; hooks are disabled and repositories with configured filters are refused.'
        : ' Checkout filters may run.'),
    async execute(ctx) {
      ctx.signal.throwIfAborted();
      const parent = await worktreeParent(repository, true);
      const destination = path.join(parent, name);
      try {
        await lstat(destination);
        throw new Error('Worktree target already exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const output = broker
        ? (
            await broker.execute(
              (invocation, signal) => captureGit(repository, [], signal, { invocation }),
              gitEnvironment(),
              ctx.signal,
            )
          ).content
        : await git(repository, ['worktree', 'add', '-b', branch, destination, 'HEAD'], ctx.signal);
      return {
        isError: false,
        content: bounded(
          `${output.trim() || 'Worktree created'}\nBranch: ${branch}\nWorkspace: ${destination}`,
        ),
      };
    },
  });
}

/**
 * Whether the workspace sits *inside* a repository whose root is above it (a monorepo package, `projects/x`).
 *
 * Every Git tool refuses that layout — the repository metadata is outside the workspace, and trusting it is the
 * escape `repositoryRoot` exists to stop — so offering the tools only taught the model to call `git_diff` and
 * relay an English refusal. The check is the cheap synchronous shape of that refusal: no `.git` at the workspace
 * root, one in an ancestor. A workspace outside any repository keeps the tools (they report "not a repository",
 * and `git init` may make one), as does a repository or managed-worktree root.
 */
export function workspaceInsideOuterRepository(root: string): boolean {
  const workspace = path.resolve(root);
  if (existsSync(path.join(workspace, '.git'))) return false;
  for (let directory = path.dirname(workspace); ;) {
    if (existsSync(path.join(directory, '.git'))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export function gitTools(root: string): Tool[] {
  const pathFilter = {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 4096 },
    maxItems: 64,
  };
  const requiredPaths = { ...pathFilter, minItems: 1 };
  return [
    {
      name: 'git_branches',
      isConcurrencySafe: parallelRead,
      description: 'List local branches and mark the branch checked out in this workspace.',
      inputSchema: schema({}),
      async execute(_args, context) {
        const repository = await repositoryRoot(root, context.signal);
        return readGit(
          repository,
          ['branch', '--list', '--format=%(HEAD) %(refname:short)'],
          context.signal,
          'No local branches',
        );
      },
    },
    {
      name: 'git_worktrees',
      isConcurrencySafe: parallelRead,
      description: 'List local Git worktrees and their checked-out branches without changing them.',
      inputSchema: schema({}),
      async execute(_args, context) {
        const repository = await repositoryRoot(root, context.signal);
        return readGit(
          repository,
          ['worktree', 'list', '--porcelain'],
          context.signal,
          'No worktrees',
        );
      },
    },
    {
      name: 'git_worktree_create',
      permission: 'command',
      description:
        'Create a new local branch from HEAD in an isolated worktree under .yuantu/worktrees/<name>. Keeps the current branch and dirty files untouched. Approval shows the branch and destination. Does not push.',
      inputSchema: schema({
        branch: { type: 'string', minLength: 1, maxLength: 128 },
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
      }),
      prepare: (args, context) => prepareWorktreeCreate(root, args, context),
      async execute(args, context) {
        return (await prepareWorktreeCreate(root, args, context)).execute(context);
      },
    },
    {
      name: 'git_status',
      isConcurrencySafe: parallelRead,
      description:
        'Read bounded Git porcelain v2 status for a repository contained in the workspace. Uses fixed arguments, isolated configuration, no prompts, and no repository mutation.',
      inputSchema: schema({}),
      async execute(_args, context) {
        const repository = await repositoryRoot(root, context.signal);
        return readGit(
          repository,
          ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
          context.signal,
          'Working tree clean',
        );
      },
    },
    {
      name: 'git_diff',
      isConcurrencySafe: parallelRead,
      description:
        'Read a bounded Git diff for working-tree, staged, or HEAD state, optionally restricted to repository-relative paths. External diff and textconv execution are disabled.',
      inputSchema: schema({
        mode: { type: 'string', enum: ['working', 'staged', 'head'] },
        paths: pathFilter,
        stat_only: { type: 'boolean' },
      }),
      async execute(args, context) {
        const repository = await repositoryRoot(root, context.signal);
        const command = ['diff', '--no-ext-diff', '--no-textconv'];
        const mode = String(args.mode ?? 'working');
        if (mode === 'staged') command.push('--cached');
        else if (mode === 'head') command.push('HEAD');
        if (args.stat_only === true) command.push('--stat');
        command.push('--', ...safePaths(args.paths));
        return readGit(repository, command, context.signal, 'No differences', false);
      },
    },
    {
      name: 'git_log',
      isConcurrencySafe: parallelRead,
      description:
        'Read bounded recent commit history for a repository contained in the workspace, optionally restricted to repository-relative paths. Read-only; use it to match the repository commit message conventions before committing.',
      inputSchema: schema({
        count: { type: 'integer', minimum: 1, maximum: 50 },
        paths: pathFilter,
        verbose: { type: 'boolean' },
      }),
      async execute(args, context) {
        const repository = await repositoryRoot(root, context.signal);
        const count = args.count === undefined ? 10 : Number(args.count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50)
          throw new Error('count must be an integer from 1 to 50');
        try {
          await git(repository, ['rev-parse', '--verify', 'HEAD'], context.signal);
        } catch (error) {
          context.signal.throwIfAborted();
          if (!(error instanceof GitCommandError) || error.exitCode !== 128) throw error;
          return { isError: false, content: 'No commits' };
        }
        const format = args.verbose === true ? '--format=%h %ad %s%n%b' : '--format=%h %ad %s';
        const command = ['log', `-n${count}`, '--date=short', format];
        const paths = safePaths(args.paths);
        if (paths.length) command.push('--', ...paths);
        return readGit(repository, command, context.signal, 'No commits');
      },
    },
    {
      name: 'git_stage',
      permission: 'command',
      description:
        'Stage or unstage explicit repository-relative paths in the index. Does not commit, push, or touch the working tree. Requires command approval. In native mode a controlled Host metadata operation refuses staging in repositories with configured filters; ordinary commands remain sandboxed. In host mode staging can run repository-configured clean filters.',
      inputSchema: schema({
        paths: requiredPaths,
        unstage: { type: 'boolean' },
      }),
      prepare: (args, context) => prepareStage(root, args, context),
      async execute(args, context) {
        return (await prepareStage(root, args, context)).execute(context);
      },
    },
    {
      name: 'git_commit',
      permission: 'command',
      description:
        'Create one commit from the currently staged changes with the given message. Native mode uses a controlled Host metadata operation with hooks disabled and checks that the approved index and HEAD are unchanged. In host mode repository hooks run by default; pass no_verify to skip them. Refuses when nothing is staged, no author identity is configured, or GPG signing is required. Never amends, rebases, or pushes.',
      inputSchema: schema({
        message: { type: 'string', minLength: 1, maxLength: MAX_COMMIT_MESSAGE },
        no_verify: { type: 'boolean' },
      }),
      prepare: (args, context) => prepareCommit(root, args, context),
      async execute(args, context) {
        return (await prepareCommit(root, args, context)).execute(context);
      },
    },
  ];
}
