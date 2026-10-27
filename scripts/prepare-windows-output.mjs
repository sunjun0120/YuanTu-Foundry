import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);

/** Generated executables must launch with normal Windows integrity, even inside a Low-labelled checkout. */
export async function prepareWindowsOutput(directory) {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') return;
  // Change this generated directory only. New executables inherit Medium; do not relabel the checkout or
  // recurse through existing files, whose security descriptors may belong to a running sandbox grant.
  await exec(
    path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/icacls.exe'),
    [path.resolve(directory), '/setintegritylevel', '(OI)(CI)M'],
    { windowsHide: true },
  );
}
