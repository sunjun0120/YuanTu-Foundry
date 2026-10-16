import fs from 'node:fs';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { inside, resolvedTarget } from './paths.mjs';
import { record as appendRecord } from './records.mjs';
const spawnSyncOriginal = childProcess.spawnSync;
const readOriginal = fs.readFileSync;

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
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      const created = Date.parse(result.stdout?.trim());
      if (result.status === 0 && created >= entry.started && created <= entry.at)
        verified.push(pid);
    }
  }
  if (typeof terminate === 'function') for (const pid of verified) await terminate(pid);
  const deadline = Date.now() + timeoutMs;
  while (typeof terminate === 'function' && remaining().length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    clean: initial.length === 0,
    remaining: remaining(),
    verified,
    terminated: typeof terminate === 'function' ? verified : [],
    records,
  };
}
