/** Owned broker protocol and deployment runtime floor. */
export const PROGRAM_PROTOCOL = 1;
export const PROGRAM_NODE_MAJOR = 24;

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USER',
  'LOGNAME',
  'SHELL',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
]);

/** Build a child environment without inheriting arbitrary host credentials or settings. */
export function toolEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENVIRONMENT_NAMES)
    if (source[name] !== undefined) env[name] = source[name];
  // Test and fixture processes use these names to communicate with their children.
  for (const name of Object.keys(source))
    if (/^FIXTURE_[A-Z0-9_]+$/.test(name) && source[name] !== undefined) env[name] = source[name];
  return env;
}

const WORKER_SAFE_ARGS = new Map<string, boolean>([
  ['--conditions', true],
  ['--disable-warning', true],
  ['--enable-source-maps', false],
  ['--experimental-import-meta-resolve', false],
  ['--experimental-strip-types', false],
  ['--no-deprecation', false],
  ['--no-warnings', false],
  ['--preserve-symlinks', false],
  ['--throw-deprecation', false],
  ['--trace-deprecation', false],
  ['--trace-uncaught', false],
  ['--trace-warnings', false],
]);

/** Keep only Node runtime flags known to be valid in worker threads. */
export function workerExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const argument = execArgv[i]!;
    const [flag] = argument.split('=', 1);
    const consumesValue = WORKER_SAFE_ARGS.get(flag!);
    if (consumesValue === undefined) continue;
    filtered.push(argument);
    if (consumesValue && !argument.includes('=') && execArgv[i + 1] !== undefined)
      filtered.push(execArgv[++i]!);
  }
  return filtered;
}

/**
 * The heap a guest worker may use, and why there has to be a number.
 *
 * `run_code` and `workflow` run a model's JavaScript in a worker thread. A worker created without
 * `resourceLimits` inherits the process's own heap, so a program that allocates without bound does not fail — it
 * takes down the *host*: the session store, the run that is in flight, every other session in the process. The
 * isolation these tools promise for guest code has always been termination rather than a sandbox (see the note on
 * `workerExecArgv` above, and `YUANTU_TOOL_MODE`'s contract), and a ceiling is what makes "the guest dies" true
 * instead of "everything dies".
 *
 * Generous on purpose. A program gets its data through tools whose results are bounded in the kilobytes, so a
 * quarter of a gigabyte is far more than any script this runtime hands over needs: this is a wall for a runaway
 * allocation, not a budget for real work, and a limit tight enough to refuse legitimate work would be the worse
 * failure of the two.
 */
export const GUEST_HEAP_MB = 256;

/**
 * The worker options that bound a guest, in one place because two runners have to agree about them.
 *
 * A function rather than a shared object because Node reads the limits when the worker starts; handing the same
 * mutable object to two workers would let a later change reach a worker that has already been created.
 */
export function guestResourceLimits(): { maxOldGenerationSizeMb: number } {
  return { maxOldGenerationSizeMb: GUEST_HEAP_MB };
}
