import { execFileSync } from 'node:child_process';

/**
 * Git with none of the machine's configuration and a fixed identity, so a test's commits do not depend on who
 * runs it or what their `~/.gitconfig` says.
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** Runs one git command in `cwd` and returns its trimmed standard output; a non-zero exit throws. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}
