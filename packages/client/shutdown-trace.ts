import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';
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
      ...(process.platform === 'win32' && hostPid !== undefined
        ? { host: inside(hostPid), stacks: stacks(hostPid) }
        : {}),
    };
    appendFileSync(path.join(artifacts, 'client-shutdown.ndjson'), JSON.stringify(line) + '\n');
  } catch {
    // A diagnostic must never be the reason a shutdown fails.
  }
}

/**
 * A Windows Host that is still alive: each thread's state, wait reason and CPU time, and the native addons it
 * loaded. A Host past its JavaScript `exit` is stuck in native teardown; these say whether a thread is spinning or
 * blocked, and which addons are in the process. (A thread's start address reads as zero from another process.)
 */
function inside(hostPid: number): unknown {
  const script = `
$p = Get-Process -Id ${hostPid} -ErrorAction SilentlyContinue
if ($p) {
  $mods = @($p.Modules)
  [pscustomobject]@{
    threads = @($p.Threads | ForEach-Object {
      $t = $_
      $wait = if ("$($t.ThreadState)" -eq 'Wait') { "$($t.WaitReason)" } else { $null }
      [pscustomobject]@{ id = $t.Id; state = "$($t.ThreadState)"; wait = $wait; cpuMs = [int]$t.TotalProcessorTime.TotalMilliseconds }
    })
    addons = @($mods | Where-Object { $_.FileName -like '*.node' } | ForEach-Object { $_.FileName })
  } | ConvertTo-Json -Compress -Depth 4
}`;
  const listing = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  try {
    return JSON.parse(listing.stdout || 'null');
  } catch {
    return listing.stdout || listing.stderr;
  }
}

/**
 * Every thread's stack in a Windows Host that is still alive, from the console debugger of the Windows SDK when the
 * machine has one (hosted runners do). A Host past its JavaScript `exit` with its main thread in an `Executive` wait
 * is blocked in a system call; the `ntdll` frame on top names which one. The attach is non-invasive (`-pv`): the
 * process is suspended only while its stacks are read, and `qd` detaches without ending it. System symbols come from
 * Microsoft's symbol server into a cache under the runner's temp directory, so only the first trace downloads them.
 */
function stacks(hostPid: number): string {
  const cdb = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'))
    .find((candidate) => existsSync(candidate));
  if (!cdb) return 'cdb.exe is not installed';
  const cache = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'foundry-symbols');
  const listing = spawnSync(
    cdb,
    [
      '-pv',
      '-p',
      String(hostPid),
      '-y',
      `srv*${cache}*https://msdl.microsoft.com/download/symbols`,
      '-c',
      '~*kc 40; qd',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const text = `${listing.stdout ?? ''}${listing.stderr ?? ''}`;
  return listing.error ? `${String(listing.error)}\n${text}` : text;
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
