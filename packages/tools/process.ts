import { spawn } from 'node:child_process';
export async function killTree(pid: number): Promise<void> {
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
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
}
