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
