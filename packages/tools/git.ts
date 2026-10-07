import { resolveSandboxConfig } from './sandbox.ts';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import type { PreparedTool, Tool, ToolContext } from '../protocol/index.ts';
import { bounded, MAX_TOOL_OUTPUT } from './registry.ts';
import { killTree } from './process.ts';

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
    'diff.external=',
    '-c',
    'diff.trustExitCode=false',
    '--no-pager',
  ];
}

async function git(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  options: { includeGlobal?: boolean; safeDirectory?: string } = {},
): Promise<string> {
  signal.throwIfAborted();
  if (resolveSandboxConfig().mode !== 'host')
    // Named by the mode rather than "Docker mode": the same guard covers every isolating backend, and telling a
    // Windows operator that Docker is why their Git is gone would send them looking for the wrong thing.
    throw new Error(
      `Native Git tools are disabled in ${resolveSandboxConfig().mode} mode because repository filters can execute host programs`,
    );
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitCommandLine(options.safeDirectory ?? root), ...args], {
      cwd: root,
      env: gitEnvironment(options.includeGlobal === true),
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
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = () => {
      if (child.pid && !killing)
        killing = killTree(child.pid).catch(() => {
          child.kill();
        });
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
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        if (killing) await killing;
        if (signal.aborted) return reject(signal.reason);
        const output =
          Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : '');
        if (timedOut) return reject(new Error(`Git command timed out after ${GIT_TIMEOUT_MS}ms`));
        if (code !== 0) return reject(new Error(bounded(output || `git exited with code ${code}`)));
        resolve(bounded(output));
      })();
    });
  });
}

function contained(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

async function managedWorktreeMetadata(repository: string, metadata: string): Promise<boolean> {
  const worktrees = path.dirname(repository);
  const state = path.dirname(worktrees);
  if (path.basename(worktrees) !== 'worktrees' || path.basename(state) !== '.yuantu') return false;
  const owner = path.dirname(state);
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

async function repositoryRoot(root: string, signal: AbortSignal): Promise<string> {
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
  if (!contained(workspace, repository))
    throw new Error('Git repository and metadata must be contained in the workspace');
  if (!contained(workspace, metadata) && !(await managedWorktreeMetadata(repository, metadata)))
    throw new Error('Git repository and metadata must be contained in the workspace');
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
  const repository = await repositoryRoot(root, context.signal);
  const paths = safePaths(args.paths);
  if (!paths.length) throw new Error('paths must list at least one repository-relative path');
  const unstage = args.unstage === true;
  return {
    approvalDescription: [
      `${unstage ? 'Unstage' : 'Stage'} ${paths.length} path(s): ${describePaths(paths)}`,
      unstage ? 'Runs: git reset -q HEAD -- <paths>' : 'Runs: git add -- <paths>',
    ].join('\n'),
    async execute(ctx: ToolContext) {
      // `git restore --staged` cannot run before the first commit; `git reset` can.
      const output = await git(
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
  };
}

async function prepareCommit(
  root: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const repository = await repositoryRoot(root, context.signal);
  const message = commitMessage(args.message);
  const staged = await stagedPaths(repository, context.signal);
  if (!staged.length) throw new Error('Nothing is staged; run git_stage before git_commit');
  const identity = await commitPreconditions(repository, context.signal);
  const noVerify = args.no_verify === true;
  return {
    approvalDescription: [
      `Commit ${staged.length} staged file(s) as ${identity.name} <${identity.email}>: ${describePaths(staged)}`,
      `Message:\n${message}`,
      noVerify
        ? 'WARNING: no_verify is set, so repository hooks will be skipped.'
        : 'Repository hooks will run; they may execute repository-controlled programs.',
    ].join('\n'),
    async execute(ctx: ToolContext) {
      const output = await git(
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
  };
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
  const repository = await repositoryRoot(root, context.signal);
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
  return {
    approvalDescription:
      `Create branch ${branch} from HEAD and check it out at ${target}.` +
      '\nThe current worktree and its uncommitted changes stay in place. Checkout filters may run.',
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
      const output = await git(
        repository,
        ['worktree', 'add', '-b', branch, destination, 'HEAD'],
        ctx.signal,
      );
      return {
        isError: false,
        content: bounded(
          `${output.trim() || 'Worktree created'}\nBranch: ${branch}\nWorkspace: ${destination}`,
        ),
      };
    },
  };
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
        const output = await git(
          repository,
          ['branch', '--list', '--format=%(HEAD) %(refname:short)'],
          context.signal,
        );
        return { isError: false, content: output.trim() || 'No local branches' };
      },
    },
    {
      name: 'git_worktrees',
      isConcurrencySafe: parallelRead,
      description: 'List local Git worktrees and their checked-out branches without changing them.',
      inputSchema: schema({}),
      async execute(_args, context) {
        const repository = await repositoryRoot(root, context.signal);
        const output = await git(repository, ['worktree', 'list', '--porcelain'], context.signal);
        return { isError: false, content: output.trim() || 'No worktrees' };
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
        const status = await git(
          repository,
          ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
          context.signal,
        );
        return { isError: false, content: status.trim() || 'Working tree clean' };
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
        return {
          isError: false,
          content: (await git(repository, command, context.signal)) || 'No differences',
        };
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
        } catch {
          context.signal.throwIfAborted();
          return { isError: false, content: 'No commits' };
        }
        const format = args.verbose === true ? '--format=%h %ad %s%n%b' : '--format=%h %ad %s';
        const command = ['log', `-n${count}`, '--date=short', format];
        const paths = safePaths(args.paths);
        if (paths.length) command.push('--', ...paths);
        const output = await git(repository, command, context.signal);
        return { isError: false, content: output.trim() || 'No commits' };
      },
    },
    {
      name: 'git_stage',
      permission: 'command',
      description:
        'Stage or unstage explicit repository-relative paths in the index. Does not commit, push, or touch the working tree. Staging can run repository-configured clean filters declared in .gitattributes, so it requires command approval; the approval shows the exact paths and operation.',
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
        'Create one commit from the currently staged changes with the given message. Repository hooks run by default; pass no_verify to skip them. Refuses when nothing is staged, when no author identity is configured, or when the repository requires GPG signing. Never amends, rebases, or pushes.',
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
