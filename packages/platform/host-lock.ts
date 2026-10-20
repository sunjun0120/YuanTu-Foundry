/**
 * The markers that say a Host process is using a workspace.
 *
 * The session database already carries leases for runs and workspace operations, but neither exists while a Host
 * is merely serving an idle workspace. Offline maintenance (`workspace-gc`) needs that fact: a release must not run
 * beside a delegation, and a Host that is between runs can still start one a moment later.
 *
 * A marker per process rather than one exclusive lock file: replacing the model deliberately starts the next Host
 * before stopping the previous one so a failed save can be rolled back, and an exclusive file would make that
 * legitimate overlap fail. Each process writes its own `<pid>-<uuid>.json` under `.yuantu/hosts/`; `workspace-gc`
 * refuses while any marker names a live process. A crashed Host leaves a stale marker whose pid is gone, and the
 * next Host (or the maintenance command) can remove it.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ownStartedAt, processAlive } from './process-identity.ts';
import { ensureRuntimeDirectory, RUNTIME_DIRECTORY_NAME } from './runtime-directory.ts';

export interface HostLockHolder {
  pid: number;
  startedAt: number | null;
}

export interface HostLock extends HostLockHolder {
  path: string;
  release(): void;
}

export interface MaintenanceGate {
  release(): void;
}

interface HostMarker extends HostLockHolder {
  token: string;
  file: string;
}

const MAINTENANCE_GATE = 'maintenance.lock';

export function hostPresenceDirectory(workspace: string): string {
  return path.join(path.resolve(workspace), RUNTIME_DIRECTORY_NAME, 'hosts');
}

function acquireFile(file: string, label: string): { token: string; release(): void } {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = randomUUID();
    try {
      writeFileSync(
        file,
        JSON.stringify({ version: 1, pid: process.pid, startedAt: ownStartedAt(), token }),
        { flag: 'wx', mode: 0o600 },
      );
      let released = false;
      return {
        token,
        release(): void {
          if (released) return;
          released = true;
          const current = readMarker(file);
          if (current?.token !== token) return;
          try {
            rmSync(file, { force: true });
          } catch {
            // Stale by pid after this process exits; the next owner removes it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readMarker(file);
      if (holder && processAlive(holder.pid, holder.startedAt))
        throw new Error(
          `${label} is already in progress in this workspace (pid ${String(holder.pid)})`,
        );
      try {
        rmSync(file, { force: true });
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError;
      }
    }
  }
  throw new Error(`Could not acquire ${label}: ${file}`);
}

function readMarker(file: string): HostMarker | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
      token?: unknown;
    };
    if (
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token ||
      (value.startedAt !== null &&
        (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)))
    )
      return null;
    return {
      pid: value.pid,
      startedAt: value.startedAt === null ? null : value.startedAt,
      token: value.token,
      file,
    };
  } catch {
    return null;
  }
}

function markers(workspace: string): HostMarker[] {
  const directory = hostPresenceDirectory(workspace);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const marker = readMarker(path.join(directory, name));
    return marker ? [marker] : [];
  });
}

/** Every Host currently holding this workspace. */
export function hostLockHolders(workspace: string): HostLockHolder[] {
  return markers(workspace)
    .filter((marker) => processAlive(marker.pid, marker.startedAt))
    .map(({ pid, startedAt }) => ({ pid, startedAt }));
}

/** The first live Host holding this workspace, or null when there is none. */
export function hostLockHolder(workspace: string): HostLockHolder | null {
  return hostLockHolders(workspace)[0] ?? null;
}

/** Remove markers whose owner is gone; called by a fresh Host and by real (not dry-run) maintenance. */
export function pruneHostMarkers(workspace: string): number {
  let removed = 0;
  for (const marker of markers(workspace)) {
    if (processAlive(marker.pid, marker.startedAt)) continue;
    try {
      rmSync(marker.file, { force: true });
      removed++;
    } catch {
      // A concurrent Host may have removed the same stale marker; the next pass will finish the job.
    }
  }
  return removed;
}

/**
 * A cross-process gate for the short window in which offline maintenance and a Host start could both decide the
 * workspace is free.
 *
 * The gate is not held for the Host's lifetime; it is held while a Host publishes its marker and for the whole of
 * `workspace-gc`'s release. A Host that starts during maintenance fails with a retryable message instead of racing
 * it, and maintenance that starts while a Host is publishing waits or refuses.
 */
export function acquireMaintenanceGate(workspace: string): MaintenanceGate {
  const directory = hostPresenceDirectory(workspace);
  ensureRuntimeDirectory(directory);
  return acquireFile(path.join(directory, MAINTENANCE_GATE), 'Workspace maintenance');
}

/**
 * Publish this process as a Host of `workspace`; the returned release removes exactly this marker.
 *
 * Several Hosts may be alive at once during a model replacement, so this never refuses. `workspace-gc` asks
 * `hostLockHolders` and refuses while any of them is live.
 */
export function acquireHostLock(workspace: string): HostLock {
  const directory = hostPresenceDirectory(workspace);
  ensureRuntimeDirectory(directory);
  const gate = acquireMaintenanceGate(workspace);
  try {
    // Opportunistic cleanup: a dead marker is not evidence of ownership and only slows every later scan.
    pruneHostMarkers(workspace);
    const startedAt = ownStartedAt();
    const token = randomUUID();
    const file = path.join(directory, `${String(process.pid)}-${token}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, startedAt, token }), {
      flag: 'wx',
      mode: 0o600,
    });
    let released = false;
    return {
      path: file,
      pid: process.pid,
      startedAt,
      release(): void {
        if (released) return;
        released = true;
        try {
          rmSync(file, { force: true });
        } catch {
          // A marker that cannot be removed is stale by pid after this process exits; the next Host repairs it.
        }
      },
    };
  } finally {
    gate.release();
  }
}
