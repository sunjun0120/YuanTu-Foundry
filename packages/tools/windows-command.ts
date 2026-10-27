/** Shared Windows argument quoting and executable resolution for the account backend. */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}
/** Extensions `CreateProcess` can start as an image without `cmd.exe`'s PATHEXT lookup. */
const NATIVE_IMAGE_EXTENSIONS = ['.exe', '.com'] as const;
/**
 * Whether a program has to be started through `cmd.exe` before `CreateProcess` sees it.
 *
 * The argv path used to hand the program straight to `CreateProcessAsUser`, which resolves the first command-line
 * token as a PE image and appends `.exe` to a bare name. That is correct for `node.exe` and wrong for every
 * package manager shim on Windows: `npm`, `pnpm`, `yarn` and `tsc` are `.cmd` files that only the shell's PATHEXT
 * search resolves, so an acceptance check written as `npm test` never started at all and reported
 * `CreateProcessAsUser 系统找不到指定的文件` — which the verifier then read as a failed assertion.
 *
 * A bare name is direct only when the `.exe`/`.com` image exists on `PATH`; anything else is shell text.
 */
export function windowsProgramNeedsShell(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const extension = path.extname(program).toLowerCase();
  if ((NATIVE_IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return false;
  if (extension) return true;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return !pathValue.split(path.delimiter).some((directory) => {
    if (!directory) return false;
    return NATIVE_IMAGE_EXTENSIONS.some((candidate) =>
      existsSync(path.join(directory, program + candidate)),
    );
  });
}
