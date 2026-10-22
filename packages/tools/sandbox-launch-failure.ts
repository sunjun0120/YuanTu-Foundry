/**
 * How a sandbox launcher reports that it never started the command at all.
 *
 * A launcher failure (the restricted token cannot be given to the image, the image does not exist) and a command
 * that ran and exited non-zero both used to arrive as "exit code 1 with some stderr". That made a machine problem
 * indistinguishable from a failing assertion, so the automatic-verification loop asked the model to repair code
 * that was never executed. The launcher now writes this one line and exits with `SANDBOX_LAUNCH_FAILED_EXIT`;
 * the checker maps that pair to `environment-error`, which `decideCompletion` treats as a stopping condition.
 *
 * Both values are protocol between the launcher script and the verifier: changing one without the other would
 * silently return to "code repairs for a broken machine".
 */
export const SANDBOX_LAUNCH_FAILED_EXIT = 125;
export const SANDBOX_LAUNCH_FAILED_PREFIX = 'YuantuSandbox launch failed: ';

/**
 * The launcher's own reason when `stderr`/`exitCode` say the command was never started, otherwise `undefined`.
 *
 * The exit code alone is not enough: a command is free to exit 125 itself. Requiring the marker as well keeps an
 * ordinary failure an ordinary failure.
 */
export function sandboxLaunchFailure(
  stderr: string,
  exitCode: number | null | undefined,
): string | undefined {
  if (exitCode !== SANDBOX_LAUNCH_FAILED_EXIT) return undefined;
  const line = stderr.split(/\r?\n/).find((entry) => entry.includes(SANDBOX_LAUNCH_FAILED_PREFIX));
  if (!line) return undefined;
  return line
    .slice(line.indexOf(SANDBOX_LAUNCH_FAILED_PREFIX) + SANDBOX_LAUNCH_FAILED_PREFIX.length)
    .trim();
}

/**
 * What a Windows-sandboxed command prints when it cannot start its own child process.
 *
 * `node --test`, vitest and jest fork per test file and get `EPERM` from `child_process` inside the restricted
 * token backend — the command is fine, the environment is not. The signatures below are the two shapes that
 * surface: Node's `Error: spawn EPERM` stack, and libuv's `EPERM (-4048) spawnSync <exe> EPERM`. A command that
 * merely reports a permission error it handled (`write failed: EPERM`) is not this failure and gets no note.
 */
export function sandboxChildSpawnBlocked(output: string): boolean {
  // No trailing `\b` after the closing parenthesis: `)` and a following space are both non-word characters, so
  // the boundary libuv's format would need does not exist there.
  return /\bspawn EPERM\b|EPERM \(-4048\)/u.test(output);
}

/** The note appended to a Windows-sandboxed command that could not fork, for the model and the reader. */
export const SANDBOX_CHILD_SPAWN_NOTE =
  'The command ran but could not start its own child process: the manually selected `windows` backend gives it a ' +
  'restricted token whose child-process creation with inherited pipes is refused (Node reports spawn EPERM). This ' +
  'is the execution environment, not the command — test runners that fork (node --test, vitest, jest) fail here. ' +
  'That backend has no separate account and weaker network isolation. Initialize sandbox accounts in Settings > ' +
  'General, switch back to native (windows-account), and retry; or run a test file directly when it does not fork.';
