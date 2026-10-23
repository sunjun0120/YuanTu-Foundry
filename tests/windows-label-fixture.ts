import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// By absolute path: a Git for Windows PATH puts coreutils' `whoami` first, which takes no `/user`.
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * Labels a test directory Low integrity, the way an untrusted tree would be.
 *
 * Setting a label needs WRITE_OWNER, which an unelevated owner lacks wherever the directory's DACL comes from an
 * inherited Authenticated Users ACE (any volume outside the profile, or a TEMP moved there). The owner always holds
 * WRITE_DAC, so it grants itself WRITE_OWNER first; on a default TEMP that grant is already implied and changes nothing.
 */
export async function labelLowIntegrity(directory: string): Promise<void> {
  const { stdout } = await execute(
    path.join(system32, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      windowsHide: true,
    },
  );
  const sid = /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
  if (!sid) throw new Error(`Cannot read the current user's SID: ${stdout}`);
  await execute(path.join(system32, 'icacls.exe'), [directory, '/grant', `*${sid}:(WO)`, '/Q'], {
    windowsHide: true,
  });
  await execute(
    path.join(system32, 'icacls.exe'),
    [directory, '/setintegritylevel', '(OI)(CI)L', '/Q'],
    {
      windowsHide: true,
    },
  );
}
