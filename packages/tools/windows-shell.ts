import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseSetting } from '../protocol/settings.ts';

/**
 * The shell that runs model-written command text on Windows.
 *
 * PowerShell rather than `cmd.exe`: models write PowerShell far more reliably than cmd's quoting, pipes and
 * `%VAR%` expansion, and every Windows machine ships Windows PowerShell 5.1. The order follows Codex's
 * (`codex-rs/shell-command/src/shell_detect.rs`): `pwsh` on PATH or in its default install directory, then
 * `powershell` on PATH or in System32, and `cmd.exe` only when neither exists.
 *
 * A Store-installed PowerShell under `WindowsApps` is skipped: the sandbox account cannot open packaged
 * executables, so a path that works on the host would fail in the native backend, and every backend has to name
 * the same shell or the execution environment the model is told about would be wrong for one of them.
 *
 * The test isolation (`scripts/test-isolation/environment.mjs`) sets `YUANTU_TEST_WINDOWS_SHELL=cmd`: a PowerShell start costs 0.4–1.2 s under the suite's
 * eight-way load against cmd's 0.1 s, which tripled the suite's wall time. `tests/windows-shell.test.ts` sets it
 * back to `auto` and covers the PowerShell path itself.
 *
 * Only shell text goes through this. A program-plus-arguments request that needs PATHEXT resolution (a `.cmd`
 * shim such as `npm`) still goes through `cmd.exe /d /s /c`, which is the one parser that resolves it.
 */
export interface WindowsShell {
  kind: 'pwsh' | 'powershell' | 'cmd';
  path: string;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of value.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.win32.join(directory, name);
    if (usable(candidate)) return candidate;
  }
  return undefined;
}

function usable(candidate: string): boolean {
  if (candidate.split(/[\\/]/).some((part) => part.toLowerCase() === 'windowsapps')) return false;
  return existsSync(candidate);
}

let cached: { key: string; shell: WindowsShell } | undefined;

/** The shell for command text, found once per PATH. */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): WindowsShell {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  if (parseSetting(env, 'YUANTU_TEST_WINDOWS_SHELL') === 'cmd')
    return { kind: 'cmd', path: env.ComSpec ?? path.win32.join(systemRoot, 'System32', 'cmd.exe') };
  const key = `${Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? ''}|${systemRoot}`;
  if (cached?.key === key) return cached.shell;
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const pwsh =
    onPath('pwsh.exe', env) ??
    fallback(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
  const powershell =
    onPath('powershell.exe', env) ??
    fallback(
      path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
  const shell: WindowsShell = pwsh
    ? { kind: 'pwsh', path: pwsh }
    : powershell
      ? { kind: 'powershell', path: powershell }
      : { kind: 'cmd', path: env.ComSpec ?? path.win32.join(systemRoot, 'System32', 'cmd.exe') };
  cached = { key, shell };
  return shell;
}

function fallback(candidate: string): string | undefined {
  return usable(candidate) ? candidate : undefined;
}

/**
 * Asks PowerShell for UTF-8 console output, and keeps progress bars out of a captured stream.
 *
 * The same prefix Codex sends (`UTF8_OUTPUT_PREFIX`), so a Chinese system's OEM code page does not reach the
 * output decoder; the decoder still recognises either encoding.
 *
 * `$PSNativeCommandArgumentPassing='Standard'` makes PowerShell 7.3+ pass a double quote inside an argument to a
 * native program intact. Windows PowerShell 5.1 has no such switch and drops those quotes (`'a "b" c'` arrives as
 * `a b c`); there the variable is an ordinary unused one, and the execution environment tells the model.
 */
const PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n$ProgressPreference='SilentlyContinue'\n$PSNativeCommandArgumentPassing='Standard'\n";
/**
 * Keeps a native program's exit code.
 *
 * `-Command` reports only 0 or 1 for the last statement, so `exit 3` from a test runner would arrive as 1. When the
 * last statement failed, its `$LASTEXITCODE` is the code (1 when a cmdlet failed and no native code is set); a
 * script that calls `exit` itself never reaches this.
 */
const SUFFIX = '\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

/**
 * The script PowerShell runs for one command.
 *
 * A command that opens with a quoted path (`"C:\Program Files\nodejs\node.exe" --version`, the way a path with
 * spaces is written in every other shell) is a string expression to PowerShell, not an invocation, and prints
 * the path instead of running it. The call operator makes it the invocation the command meant.
 */
export function powershellScript(command: string): string {
  const invoked = /^\s*["']/.test(command) ? `& ${command.trimStart()}` : command;
  return `${PREFIX}${invoked}${SUFFIX}`;
}

/** The arguments that run `command` in `shell`, before any quoting for `CreateProcess`. */
export function windowsShellArgs(shell: WindowsShell, command: string): string[] {
  if (shell.kind === 'cmd') return ['/d', '/s', '/c', `"${command}"`];
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    // Process scope only: without it `npm` resolves to `npm.ps1`, which the default policy refuses to run.
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellScript(command),
  ];
}

/** How the shell is named to the model in the execution-environment section. */
export function windowsShellLabel(shell: WindowsShell): string {
  return shell.kind === 'pwsh'
    ? 'PowerShell (pwsh)'
    : shell.kind === 'powershell'
      ? 'Windows PowerShell 5.1'
      : 'cmd.exe';
}
