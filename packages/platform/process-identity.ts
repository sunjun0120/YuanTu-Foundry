import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/**
 * Which process a pid names, not merely whether some process holds it.
 *
 * A run row records its owner's pid, and recovery used to treat "a process with that pid exists" as "the owner is
 * alive". Windows hands pids out again quickly, so a Host that crashed left its session stuck as *running* for as
 * long as an unrelated process happened to hold the same number — the session could not be continued, deleted or
 * renamed until that stranger exited. The fix is the pair (pid, start time): a process's start time does not change
 * while it lives, and a different process under the same pid started later.
 *
 * The comparison tolerates {@link START_TOLERANCE_MS} because the two sides are measured differently: this process
 * stamps its own start from `performance.timeOrigin` (no subprocess on the hot path of `beginRun`), and another
 * process's start comes from the operating system. A pid reused within that window of the original's start is not
 * distinguished — that is the old behaviour, never a worse one.
 *
 * Every uncertain answer leans to "alive". Calling a live owner dead hands its session to a second writer; calling
 * a dead one alive only keeps the session waiting, which is what happened before this check existed.
 */
export const START_TOLERANCE_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;
/**
 * How long a looked-up start time is trusted. Long enough to cover one recovery pass, short enough that a pid the
 * owner released and the system handed to a new process is not judged by the old owner's start for long.
 */
const CACHE_MS = 5_000;

/** When this process started, in epoch milliseconds. */
export function ownStartedAt(): number {
  return Math.round(performance.timeOrigin);
}

const cache = new Map<number, { startedAt: number | null; at: number }>();

/**
 * When the process holding `pid` started, in epoch milliseconds, or `null` when the system will not say.
 *
 * Cached briefly per pid: recovery asks about the same few owners for every row they own, and on Windows each
 * answer is a subprocess.
 */
export function processStartedAt(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return ownStartedAt();
  const cached = cache.get(pid);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.startedAt;
  let startedAt: number | null = null;
  try {
    startedAt = lookup(pid);
  } catch {
    startedAt = null;
  }
  cache.set(pid, { startedAt, at: Date.now() });
  return startedAt;
}

/**
 * Look up many pids at once and cache the answers, so that a pass deciding about each of them afterwards — inside a
 * database write transaction, typically — reads the cache instead of starting one subprocess per pid.
 *
 * On Windows and macOS this is a single subprocess for the whole set. Pids that are not running, this process's own
 * and ones already cached are skipped; a pid the system would not describe is cached as unknown (`null`), which
 * `processAlive` reads as alive, exactly as a single lookup would.
 */
export function primeProcessStartTimes(pids: Iterable<number>): void {
  const wanted = new Set<number>();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const cached = cache.get(pid);
    if (cached && Date.now() - cached.at < CACHE_MS) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
    }
    wanted.add(pid);
  }
  if (!wanted.size) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    for (const pid of wanted) processStartedAt(pid);
    return;
  }
  let found = new Map<number, number>();
  try {
    found = batchLookup([...wanted]);
  } catch {
    // Leave the set uncached: each pid is then looked up on its own, as before.
    return;
  }
  const at = Date.now();
  for (const pid of wanted) cache.set(pid, { startedAt: found.get(pid) ?? null, at });
}

function batchLookup(pids: number[]): Map<number, number> {
  const found = new Map<number, number>();
  if (process.platform === 'darwin') {
    const text = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of text.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      const parsed = match ? Date.parse(match[2]!) : NaN;
      if (match && Number.isFinite(parsed)) found.set(Number(match[1]), parsed);
    }
    return found;
  }
  const text = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, [DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds() } catch {} }`,
    ],
    {
      encoding: 'utf8',
      timeout: LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+)$/.exec(line.trim());
    if (match) found.set(Number(match[1]), Number(match[2]));
  }
  return found;
}

function lookup(pid: number): number | null {
  if (process.platform === 'linux') {
    // Field 22 of /proc/<pid>/stat is the start in clock ticks after boot; the command name (field 2) may hold
    // spaces and parentheses, so the fields are counted from the last `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    // USER_HZ is 100 on every mainstream kernel configuration.
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  }
  if (process.platform === 'darwin') {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: LOOKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (process.platform === 'win32') {
    const text = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()`,
      ],
      {
        encoding: 'utf8',
        timeout: LOOKUP_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Whether the process recorded as (`pid`, `startedAt`) is still running.
 *
 * `startedAt` is null for rows written before it was recorded; those are judged by the pid alone, exactly as before.
 * A pid that exists is a different process only when its start time is known and lies outside the tolerance.
 */
export function processAlive(pid: number, startedAt: number | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (startedAt === null) return true;
  const actual = processStartedAt(pid);
  return actual === null || Math.abs(actual - startedAt) <= START_TOLERANCE_MS;
}
