import { spawn } from 'node:child_process';

const TERMINATION_TIMEOUT_MS = 5000;

/**
 * End a process tree.
 *
 * On POSIX the tree is the process group, so `signal` is delivered the way `kill -<signal> -- -<pid>` would:
 * `SIGTERM` asks the whole tree to end, `SIGKILL` ends it outright — the default, because it is the only
 * signal that always ends the tree. A Windows console has no signal delivery at all, so there the tree is
 * always ended by force (`taskkill /T /F`); the name is what the caller asked for, not something this function
 * can honour on that platform, and reporting it accurately stays the caller's job.
 *
 * "Already gone" is success, not failure. A caller ends a tree because it wants the tree stopped, and a tree
 * that has already stopped satisfies that; `taskkill` answers `128` ("the process was not found") for exactly
 * this case, which happens whenever the process exits between the caller's decision and this call — an ordinary
 * race, not a defect. Reporting it as a termination failure used to turn a completed conversion into a failed
 * test under load. So any non-zero answer is resolved only after asking the operating system whether the pid is
 * still there, and only a pid that is still alive is an error.
 */
export async function killTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  const code = await taskkill(pid);
  if (code === 0 || !processExists(pid)) return;
  throw new Error(
    code === null
      ? 'Process tree termination timed out; descendants may still be running'
      : `Process tree termination failed (taskkill exited ${code}); descendants may still be running`,
  );
}

/**
 * Run `taskkill /T /F` and answer its exit code, or `null` when the tool itself could not answer in time.
 *
 * A timeout is not decided here: it is reported as "no answer", and the caller checks liveness before calling
 * it a failure. That keeps a slow but successful termination from being reported as a stuck one.
 */
function taskkill(pid: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, TERMINATION_TIMEOUT_MS);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => finish(code ?? null));
  });
}

/**
 * End what a Windows process tree left behind after `taskkill /T`.
 *
 * `taskkill` walks the tree as it is at that moment. A PowerShell host killed while it is starting a native program
 * can finish creating that child after the walk, and under load it does so about half the time: the child outlives
 * the shell, keeps its inherited stdout pipe open, and the caller waiting for the shell's streams to close waits
 * until its own deadline. Such an orphan still records the dead shell as its parent, so it can be found and ended.
 *
 * Only after the shell is gone: a pid that is alive again belongs to some other process now, and so do its children.
 */
export async function killOrphans(pid: number): Promise<void> {
  if (process.platform !== 'win32' || processExists(pid)) return;
  const listing = await new Promise<string>((resolve) => {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const child = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.ProcessId }`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    const timer = setTimeout(() => child.kill(), TERMINATION_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', () => resolve(''));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
  const orphans = listing
    .split(/\s+/)
    .map(Number)
    .filter((orphan) => Number.isInteger(orphan) && orphan > 0);
  await Promise.all(orphans.map((orphan) => killTree(orphan).catch(() => {})));
}

/** Whether a pid is still alive; a pid this process may not signal still exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
