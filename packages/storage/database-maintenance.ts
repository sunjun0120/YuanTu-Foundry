import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface DatabasePolicy {
  application: string;
  applicationId: number;
  format: number;
  maxVersion: number;
}
/** Serialize initialization as a whole: no backup may observe another opener's partial DDL. */
export function initializeDatabase<T>(file: string, action: () => T): T {
  return file === ':memory:' ? action() : gated(identity(file), action);
}
export interface BackupPolicy {
  maxCount: number;
  maxBytes: number;
}
export const DEFAULT_BACKUP_POLICY: BackupPolicy = { maxCount: 5, maxBytes: 512 * 1024 * 1024 };
export interface DatabaseInspection {
  file: string;
  version: number;
  bytes: number;
}
export interface DatabaseBackup extends DatabaseInspection {
  source: string;
  sha256: string;
  createdAt: string;
  reason: 'manual' | 'migration';
}

function identity(file: string): string {
  const absolute = path.resolve(file);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
}
function digest(file: string): string {
  const fd = openSync(file, 'r');
  try {
    // Stream the hash through a descriptor: a session database need not fit in memory.
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = readSyncBuffer(fd, buffer)) > 0) hash.update(buffer.subarray(0, n));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
const readSyncBuffer = (fd: number, buffer: Buffer): number =>
  readSync(fd, buffer, 0, buffer.length, null);
function syncFile(file: string): void {
  // FlushFileBuffers on Windows requires a descriptor opened for writing.
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeJson(file: string, data: unknown): void {
  const stage = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(stage, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    syncFile(stage);
    renameSync(stage, file);
  } finally {
    rmSync(stage, { force: true });
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Serialize registration and maintenance. A malformed crash lock is refused, never guessed away. */
function gated<T>(file: string, action: () => T): T {
  const lock = `${file}.maintenance-lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 5000;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Never unlink a stale lock automatically: two reclaimers could remove a new owner's lock.
      if (Date.now() >= deadline)
        throw new Error(
          `Database maintenance lock requires inspection; close all users before removing it: ${lock}`,
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(fd, owner);
    fsyncSync(fd);
    return action();
  } finally {
    closeSync(fd);
    if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) rmSync(lock);
  }
}
function assertOffline(file: string): void {
  const directory = `${file}.users`;
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const pid = Number(name.split('-')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid))
      throw new Error(
        `Database has an active reader/writer; close its Host and CLI first: ${file} (${name})`,
      );
    rmSync(path.join(directory, name));
  }
}
/** Maintenance callers can hold the same gate as Store registration while inspecting offline data. */
export function offlineDatabaseOperation<T>(file: string, action: () => T): T {
  const canonical = identity(file);
  return gated(canonical, () => {
    assertOffline(canonical);
    return action();
  });
}
/** Keep ordinary Store admission closed across a database + desktop-profile recovery. */
export function beginDesktopRollback(file: string, journal: string): () => void {
  const canonical = identity(file),
    marker = `${canonical}.desktop-rollback.json`;
  gated(canonical, () => {
    assertOffline(canonical);
    if (existsSync(marker)) {
      const previous = JSON.parse(readFileSync(marker, 'utf8')) as { journal: string; pid: number };
      if (previous.journal !== journal || (previous.pid !== process.pid && alive(previous.pid)))
        throw new Error('Another desktop recovery is incomplete or active');
    }
    writeJson(marker, { journal, pid: process.pid });
  });
  return () =>
    gated(canonical, () => {
      const previous = JSON.parse(readFileSync(marker, 'utf8')) as { journal: string; pid: number };
      if (previous.journal !== journal || previous.pid !== process.pid)
        throw new Error('Desktop recovery ownership changed');
      rmSync(marker);
    });
}
function pendingRestore(file: string): RestoreJournal | undefined {
  const receipt = `${file}.restore.json`;
  if (!existsSync(receipt)) return undefined;
  const journal = JSON.parse(readFileSync(receipt, 'utf8')) as RestoreJournal;
  if (
    journal.target !== file ||
    !['prepared', 'installed', 'completed', 'rolled-back'].includes(journal.phase)
  )
    throw new Error(`Invalid restore journal: ${receipt}`);
  return journal.phase === 'completed' || journal.phase === 'rolled-back' ? undefined : journal;
}
/** Every SessionStore participates, so an offline replacement cannot race another cooperating Host. */
export function registerDatabase(file: string): () => void {
  if (file === ':memory:') return () => {};
  const canonical = identity(file);
  return gated(canonical, () => {
    if (existsSync(`${canonical}.desktop-rollback.json`))
      throw new Error(
        `Desktop rollback was interrupted; resume its offline upgrade recovery before opening: ${canonical}.desktop-rollback.json`,
      );
    if (pendingRestore(canonical))
      throw new Error(
        `Database restore was interrupted; run db-recover --db "${canonical}" before opening`,
      );
    const directory = `${canonical}.users`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const token = path.join(directory, `${process.pid}-${randomUUID()}`);
    writeFileSync(token, '', { flag: 'wx', mode: 0o600 });
    return () => rmSync(token, { force: true });
  });
}

/** Read-only inspection deliberately never opens a SessionStore (which would migrate). */
export function inspectDatabase(file: string, policy: DatabasePolicy): DatabaseInspection {
  const canonical = identity(file);
  if (existsSync(`${canonical}.json`)) {
    const manifest = JSON.parse(readFileSync(`${canonical}.json`, 'utf8')) as DatabaseBackup;
    if (
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
      digest(canonical) !== manifest.sha256 ||
      (existsSync(`${canonical}-wal`) && statSync(`${canonical}-wal`).size > 0)
    )
      throw new Error(`Backup checksum check failed: ${canonical}`);
  }
  const db = new DatabaseSync(canonical, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error(`Database integrity check failed: ${canonical}`);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error(`Database foreign key check failed: ${canonical}`);
    const claimed = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
    if (claimed !== 0 && claimed !== policy.applicationId)
      throw new Error(`Database belongs to another application: ${canonical}`);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (tables.includes('application_marker')) {
      const marker = db.prepare('SELECT application,format FROM application_marker LIMIT 1').get();
      if (
        !marker ||
        marker.application !== policy.application ||
        Number(marker.format) > policy.format
      )
        throw new Error(`Database application marker is incompatible: ${canonical}`);
    } else if (!tables.includes('sessions')) {
      throw new Error(`Database is not a recognized session database: ${canonical}`);
    }
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > policy.maxVersion)
      throw new Error(
        `Unsupported session database version: ${version} (maximum ${policy.maxVersion})`,
      );
    return { file: canonical, version, bytes: statSync(canonical).size };
  } finally {
    db.close();
  }
}

/** VACUUM INTO takes SQLite's committed snapshot, including WAL; the source is never copied bytewise. */
export function createDatabaseBackup(
  db: DatabaseSync,
  file: string,
  policy: DatabasePolicy,
  reason: DatabaseBackup['reason'],
  retention: BackupPolicy = DEFAULT_BACKUP_POLICY,
): DatabaseBackup {
  const source = identity(file);
  return gated(`${source}.backup`, () => createBackup(db, source, policy, reason, retention));
}
function createBackup(
  db: DatabaseSync,
  source: string,
  policy: DatabasePolicy,
  reason: DatabaseBackup['reason'],
  retention: BackupPolicy,
): DatabaseBackup {
  if (
    !Number.isSafeInteger(retention.maxCount) ||
    retention.maxCount < 1 ||
    !Number.isSafeInteger(retention.maxBytes) ||
    retention.maxBytes < 1
  )
    throw new Error('Invalid database backup retention policy');
  const directory = `${source}.backups`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${Date.now()}-${randomUUID()}.sqlite`);
  const stage = `${destination}.tmp`;
  let published = false;
  try {
    db.prepare('VACUUM main INTO ?').run(stage);
    const inspection = inspectDatabase(stage, policy);
    if (inspection.bytes > retention.maxBytes)
      throw new Error(`Snapshot exceeds backup capacity (${retention.maxBytes} bytes): ${source}`);
    syncFile(stage);
    renameSync(stage, destination);
    const backup: DatabaseBackup = {
      ...inspection,
      file: destination,
      source,
      sha256: digest(destination),
      createdAt: new Date().toISOString(),
      reason,
    };
    writeJson(`${destination}.json`, backup);
    published = true;
    // Only snapshots with our manifest and this source are retention candidates. Recovery copies are separate.
    const entries: DatabaseBackup[] = [];
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sqlite.json'))) {
      try {
        const entry = JSON.parse(
          readFileSync(path.join(directory, name), 'utf8'),
        ) as DatabaseBackup;
        const ownedFile = path.join(directory, name.slice(0, -5));
        if (entry.source === source && entry.file === ownedFile && existsSync(ownedFile))
          entries.push({ ...entry, bytes: statSync(ownedFile).size });
      } catch {
        /* Unknown files are never removed by retention. */
      }
    }
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
    // The snapshot just produced is always retained, even when timestamps tie.
    const ordered = [backup, ...entries.filter((entry) => entry.file !== destination)];
    let bytes = 0;
    for (const [index, entry] of ordered.entries()) {
      bytes += entry.bytes;
      if (index >= retention.maxCount || bytes > retention.maxBytes) {
        rmSync(entry.file);
        rmSync(`${entry.file}.json`);
      }
    }
    return backup;
  } catch (error) {
    rmSync(stage, { force: true });
    if (!published) {
      rmSync(destination, { force: true });
      rmSync(`${destination}.json`, { force: true });
    }
    throw new Error(`Database backup failed for ${source}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
export function backupDatabase(file: string, policy: DatabasePolicy): DatabaseBackup {
  inspectDatabase(file, policy);
  const db = new DatabaseSync(identity(file), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return createDatabaseBackup(db, file, policy, 'manual');
  } finally {
    db.close();
  }
}

interface RestoreJournal {
  target: string;
  candidate: string;
  recoveryDirectory: string;
  phase: 'prepared' | 'installed' | 'completed' | 'rolled-back';
  originals: { suffix: string; sha256: string }[];
}
function record(journal: RestoreJournal): void {
  writeJson(path.join(journal.recoveryDirectory, 'restore.json'), journal);
  writeJson(`${journal.target}.restore.json`, journal);
}
function preserveCurrent(target: string, candidate: string): RestoreJournal {
  const recoveryDirectory = `${target}.recovery-${Date.now()}-${randomUUID()}`;
  mkdirSync(recoveryDirectory, { mode: 0o700 });
  const originals: RestoreJournal['originals'] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(`${target}${suffix}`)) continue;
    const preserved = path.join(recoveryDirectory, `database.sqlite${suffix}`);
    copyFileSync(`${target}${suffix}`, preserved);
    syncFile(preserved);
    const sha256 = digest(preserved);
    if (sha256 !== digest(`${target}${suffix}`))
      throw new Error(`Database changed during preservation: ${target}${suffix}`);
    originals.push({ suffix, sha256 });
  }
  return { target, candidate, recoveryDirectory, phase: 'prepared', originals };
}
/** Explicit maintainer operation; ordinary run tools and Host RPC do not expose it. */
export function restoreDatabase(
  file: string,
  candidate: string,
  policy: DatabasePolicy,
): RestoreJournal {
  const target = identity(file);
  return gated(target, () => {
    assertOffline(target);
    if (pendingRestore(target))
      throw new Error('A previous restore is incomplete; run db-recover first');
    const inspected = inspectDatabase(candidate, policy);
    if (inspected.file === target) throw new Error('Restore source and destination must differ');
    const stage = `${target}.${randomUUID()}.restore-stage`;
    try {
      // Re-snapshot the candidate too, so an external candidate with WAL is safe and inspected after copying.
      const db = new DatabaseSync(inspected.file, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare('VACUUM main INTO ?').run(stage);
      } finally {
        db.close();
      }
      inspectDatabase(stage, policy);
      syncFile(stage);
      const journal = preserveCurrent(target, inspected.file);
      record(journal);
      for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
      renameSync(stage, target);
      journal.phase = 'installed';
      record(journal);
      inspectDatabase(target, policy);
      journal.phase = 'completed';
      record(journal);
      return journal;
    } catch (error) {
      throw new Error(
        `Database restore failed for ${target}; inspect its restore journal and use db-recover if pending: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      rmSync(stage, { force: true });
    }
  });
}

/** Roll back an interrupted replacement byte-for-byte, including corrupt/future originals and their WAL. */
export function recoverDatabase(file: string): RestoreJournal {
  const target = identity(file);
  return gated(target, () => {
    assertOffline(target);
    const journal = pendingRestore(target);
    if (!journal) throw new Error('No interrupted restore to recover');
    const directory = journal.recoveryDirectory;
    if (
      path.dirname(directory) !== path.dirname(target) ||
      !path.basename(directory).startsWith(`${path.basename(target)}.recovery-`)
    )
      throw new Error('Invalid recovery directory in restore journal');
    if (journal.originals.some((entry) => !['', '-wal', '-shm'].includes(entry.suffix)))
      throw new Error('Invalid original file in restore journal');
    for (const entry of journal.originals) {
      if (digest(path.join(directory, `database.sqlite${entry.suffix}`)) !== entry.sha256)
        throw new Error('Preserved original failed its checksum; refusing recovery');
    }
    // Preserve the failed replacement as well, so rolling back cannot destroy new evidence.
    preserveCurrent(target, journal.candidate);
    for (const suffix of ['', '-wal', '-shm']) {
      const original = journal.originals.find((entry) => entry.suffix === suffix);
      if (original) {
        const stage = `${target}${suffix}.${randomUUID()}.recover-stage`;
        copyFileSync(path.join(directory, `database.sqlite${suffix}`), stage);
        syncFile(stage);
        renameSync(stage, `${target}${suffix}`);
      } else rmSync(`${target}${suffix}`, { force: true });
    }
    journal.phase = 'rolled-back';
    record(journal);
    return journal;
  });
}
