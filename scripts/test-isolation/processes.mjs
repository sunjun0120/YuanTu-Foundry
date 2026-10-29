import fs from 'node:fs';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { inside, resolvedTarget } from './paths.mjs';
import { record as appendRecord } from './records.mjs';
const spawnSyncOriginal = childProcess.spawnSync;
const readOriginal = fs.readFileSync;
/**
 * Where the restricted-token Windows sandbox keeps its leases and ACL recovery journals for one test file.
 *
 * The product keeps them in the account profile on purpose, so nothing a guest controls can move them. In a test run
 * that shared directory made one file's retained journal block every later file with `windows-sandbox-needs-restore`,
 * and let a failing test block the developer's own YuanTu. Each file gets its own; the scheduler fails a file that
 * leaves anything in it.
 */
export function windowsSandboxStateDirectory(root) {
  return path.join(root, 'windows-sandbox-state');
}

function processIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      return readOriginal(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

export function installProcessProbe(config, violate) {
  // Descendants mirror lifecycle only into ancestor ledgers. Violations remain scoped to their owner.
  const record = (value) => {
    for (const destination of new Set([config.processPath, ...(config.ancestorProcessPaths ?? [])]))
      appendRecord(destination, value);
  };
  const registration = randomUUID();
  const registeredAt = Date.now();
  if (isMainThread)
    record({
      event: 'owner-start',
      pid: process.pid,
      parent: process.ppid,
      registration,
      // A self-registering process already exists here. Any later PID reuse has a later creation time.
      started: registeredAt - Math.ceil(process.uptime() * 1000) - 1000,
      at: registeredAt,
      identity: processIdentity(process.pid),
    });
  if (isMainThread)
    process.once('exit', () =>
      record({ event: 'owner-exit', pid: process.pid, registration, at: Date.now() }),
    );
  globalThis[Symbol.for('yuantu.test-lifecycle')] = {
    windowsSandboxState: windowsSandboxStateDirectory(config.root),
    require(resource) {
      if (!config.resources.includes(resource))
        violate('resource', `native operation requires @test-serial ${resource}`);
    },
    track(pid, started) {
      if (!Number.isSafeInteger(pid) || pid <= 0)
        violate('process', 'native process did not provide an owned PID');
      record({
        event: 'spawn',
        pid,
        owner: process.pid,
        started,
        at: Date.now(),
        identity: processIdentity(pid),
        native: true,
      });
      return () => record({ event: 'exit', pid, owner: process.pid, at: Date.now(), native: true });
    },
  };
  const validate = (args) => {
    const options = args.find(
      (value) =>
        value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof URL),
    );
    if (options?.cwd !== undefined) {
      const cwd = resolvedTarget(options.cwd);
      if (!cwd || (!inside(config.root, cwd) && cwd !== resolvedTarget(config.repository)))
        violate('cwd', `child cwd outside worker ownership or repository: ${String(options.cwd)}`);
    }
  };
  const tracked = new WeakSet();
  const track = (child, started) => {
    if (tracked.has(child)) return child;
    tracked.add(child);
    if (child.pid)
      record({
        event: 'spawn',
        pid: child.pid,
        owner: process.pid,
        started,
        at: Date.now(),
        identity: processIdentity(child.pid),
      });
    child.once('exit', () => {
      if (child.pid) record({ event: 'exit', pid: child.pid, owner: process.pid, at: Date.now() });
    });
    return child;
  };
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const method = childProcess[name];
    childProcess[name] = function (...args) {
      validate(args);
      // Normal application children inherit the worker environment. Guest allowlists remain real.
      const started = Date.now();
      return track(Reflect.apply(method, this, args), started);
    };
    if (name === 'exec' || name === 'execFile') {
      const wrapped = childProcess[name];
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args) => {
          let child;
          const promise = new Promise((resolve, reject) => {
            child = wrapped(...args, (error, stdout, stderr) => {
              if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
              } else resolve({ stdout, stderr });
            });
          });
          promise.child = child;
          return promise;
        },
      });
    }
  }
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const method = childProcess[name];
    childProcess[name] = function (...args) {
      validate(args);
      // exec*Sync returns only output; preloaded Node descendants self-register in the ledger.
      const result = Reflect.apply(method, this, args);
      if (result?.pid) {
        record({
          event: 'spawn',
          pid: result.pid,
          owner: process.pid,
          synchronous: true,
          at: Date.now(),
        });
        record({
          event: 'exit',
          pid: result.pid,
          owner: process.pid,
          synchronous: true,
          at: Date.now(),
        });
      }
      return result;
    };
  }
}

export function readIsolationViolations(isolation) {
  try {
    return fs
      .readFileSync(isolation.violationPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * How long the operating system may take to create a process `spawn()` has already returned from.
 *
 * On Windows `child_process.spawn` returns before the process exists, so the `at` recorded for a spawn is an
 * upper bound on the *call*, not on the creation: measured on this machine, the child is created 4–6 ms after
 * `at`, every time. Requiring `creationTime <= at` therefore failed for ordinary children, and an unverified
 * child is treated as one this run does not own: it stayed in `remaining`, the file reported unconfirmed
 * cleanup, and the scheduler stopped every remaining test file. The grace keeps the proof's meaning — a pid
 * reused much later still has a later creation time — while covering process creation itself.
 */
const CREATION_GRACE_MS = 2000;

/** Settle only registered children; never infer ownership from unrelated OS processes. */
export async function settleProcesses(isolation, { terminate, timeoutMs = 3000 } = {}) {
  let records = [];
  try {
    records = fs
      .readFileSync(isolation.processPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const active = new Map();
  for (const entry of records) {
    if (entry.event === 'spawn' || entry.event === 'owner-start') active.set(entry.pid, entry);
    if (entry.event === 'owner-exit' && active.get(entry.pid)?.registration === entry.registration)
      active.delete(entry.pid);
    if (entry.event === 'exit') {
      const owner = active.get(entry.pid);
      if (owner?.owner === entry.owner || owner?.parent === entry.owner) active.delete(entry.pid);
    }
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      return true;
    }
  };
  const remaining = () => [...active.keys()].filter(alive);
  const initial = remaining();
  const verified = [];
  for (const pid of initial) {
    const entry = active.get(pid);
    if (entry.identity && processIdentity(pid) === entry.identity) verified.push(pid);
    else if (process.platform === 'win32' && Number.isFinite(entry.started)) {
      const result = spawnSyncOriginal(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`,
        ],
        // This is an identity proof, not a performance assertion. Cold WMI startup under
        // concurrent suites needs more time; a failed proof still forbids termination.
        { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      );
      const created = Date.parse(result.stdout?.trim());
      const latestCreation =
        (Number.isFinite(entry.at) ? entry.at : entry.started) + CREATION_GRACE_MS;
      // A force-killed owner cannot record its exit. Its PID can already belong to
      // another suite by settlement time; positive proof of a newer creation retires
      // that stale registration without killing or reporting the unrelated process.
      // A failed identity query still leaves the entry active and fails cleanup.
      if (result.status === 0 && created > latestCreation) active.delete(pid);
      if (result.status === 0 && created >= entry.started && created <= latestCreation)
        verified.push(pid);
    }
  }
  if (typeof terminate === 'function') for (const pid of verified) await terminate(pid);
  const deadline = Date.now() + timeoutMs;
  while (typeof terminate === 'function' && remaining().length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const finalRemaining = remaining();
  // An unverified registration may disappear while its ownership is being checked.
  // Confirmed absence retires it; a verified leak still fails even after cleanup.
  for (const pid of initial)
    if (!verified.includes(pid) && !finalRemaining.includes(pid)) active.delete(pid);
  return {
    clean: initial.every((pid) => !active.has(pid)),
    remaining: finalRemaining,
    verified,
    terminated: typeof terminate === 'function' ? verified : [],
    records,
  };
}
