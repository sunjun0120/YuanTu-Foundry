import { spawn } from 'node:child_process';
/**
 * End a process tree.
 *
 * On POSIX the tree is the process group, so `signal` is delivered the way `kill -<signal> -- -<pid>` would:
 * `SIGTERM` asks the whole tree to end, `SIGKILL` ends it outright — the default, because it is the only
 * signal that always ends the tree. A Windows console has no signal delivery at all, so there the tree is
 * always ended by force (`taskkill /T /F`); the name is what the caller asked for, not something this function
 * can honour on that platform, and reporting it accurately stays the caller's job.
 */
export async function killTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Process tree termination timed out'));
      }, 5000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              new Error(
                'Process tree termination failed; descendant processes may still be running',
              ),
            );
      });
    });
  } else {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
