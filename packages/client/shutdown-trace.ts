import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What was still running when a Host's graceful stop timed out, for a test run chasing that timeout.
 *
 * Off unless `FOUNDRY_TEST_SHUTDOWN_TRACE=1` and this process runs under a test worker, like the Host's own
 * `host-shutdown.ndjson`. That file shows how far the Host got, up to its JavaScript `exit` event; this one is
 * the client's side of the same stop: where the transport says it is stuck, whether the Host process still
 * exists, and what else is around it. On Windows that is the Host itself, every process whose parent is the
 * Host or this client (the parent id survives the parent), and any `WerFault.exe`, which holds a process that
 * crashed on its way out open while it writes the report.
 */
export function traceUnconfirmedShutdown(hostPid: number | undefined, state: string | undefined) {
  const artifacts = process.env.FOUNDRY_TEST_ARTIFACTS;
  if (process.env.FOUNDRY_TEST_SHUTDOWN_TRACE !== '1' || !artifacts) return;
  try {
    const line = {
      time: new Date().toISOString(),
      clientPid: process.pid,
      hostPid,
      state,
      processes: around(hostPid),
    };
    appendFileSync(path.join(artifacts, 'client-shutdown.ndjson'), JSON.stringify(line) + '\n');
  } catch {
    // A diagnostic must never be the reason a shutdown fails.
  }
}

function around(hostPid: number | undefined): unknown {
  const parents = [process.pid, ...(hostPid === undefined ? [] : [hostPid])];
  if (process.platform === 'win32') {
    const filter = [
      ...parents.map((pid) => `ParentProcessId=${pid}`),
      ...(hostPid === undefined ? [] : [`ProcessId=${hostPid}`]),
      "Name='WerFault.exe'",
    ].join(' or ');
    const listing = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
          'Select-Object ProcessId,ParentProcessId,Name,ThreadCount,CreationDate,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    try {
      return JSON.parse(listing.stdout || 'null');
    } catch {
      return listing.stdout;
    }
  }
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return (listing.stdout ?? '')
    .split('\n')
    .map((row) => row.trim().split(/\s+/))
    .filter(([pid, ppid]) => parents.includes(Number(ppid)) || Number(pid) === hostPid)
    .map(([pid, ppid, ...args]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      args: args.join(' '),
    }));
}
