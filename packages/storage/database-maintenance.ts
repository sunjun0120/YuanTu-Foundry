import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
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

const heldGates = new Set<string>();

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
      if (Date.now() >= deadline) {
        let contents: string;
        try {
          contents = readFileSync(lock, 'utf8');
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw inspectionError;
        }
        const record = contents.match(/^(\d+):[a-f0-9-]{36}$/i);
        const pid = Number(record?.[1]);
        if (Number.isSafeInteger(pid) && pid > 0 && alive(pid))
          throw new Error(
            `Database maintenance is active (process ${pid}); wait for it to finish: ${lock}`,
          );
        throw new Error(
          `Database maintenance lock requires inspection; close all users before removing it: ${lock}`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  let createdLock: ReturnType<typeof fstatSync> | undefined;
  let ownerWritten = false;
  try {
    createdLock = fstatSync(fd);
    writeFileSync(fd, owner);
    ownerWritten = true;
    fsyncSync(fd);
    heldGates.add(file);
    return action();
  } finally {
    heldGates.delete(file);
    closeSync(fd);
    if (createdLock && existsSync(lock)) {
      const currentLock = lstatSync(lock);
      if (
        currentLock.dev === createdLock.dev &&
        currentLock.ino === createdLock.ino &&
        (!ownerWritten || readFileSync(lock, 'utf8') === owner)
      )
        rmSync(lock);
    }
  }
}
function registerUser(file: string): () => void {
  const directory = `${file}.users`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = path.join(directory, `${process.pid}-${randomUUID()}`);
  writeFileSync(token, '', { flag: 'wx', mode: 0o600 });
  return () => rmSync(token, { force: true });
}
function withReadOnlyDatabase<T>(file: string, action: (db: DatabaseSync) => T): T {
  const canonical = identity(file);
  // An offline/initialization owner already excludes replacement. Do not reacquire its gate,
  // and allow it to verify an installed database whose restore receipt is still pending.
  const release = heldGates.has(canonical)
    ? registerUser(canonical)
    : gated(canonical, () => registerUser(canonical));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(canonical, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    return action(db);
  } finally {
    // Fail closed if SQLite cannot close: a still-open reader must retain its registration.
    db?.close();
    const unregister = () => {
      release();
      const directory = `${canonical}.users`;
      if (readdirSync(directory).length === 0) rmdirSync(directory);
    };
    // Removing an empty directory must share registration's gate, or a new opener could lose it.
    if (heldGates.has(canonical)) unregister();
    else gated(canonical, unregister);
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
    return registerUser(canonical);
  });
}

/** Read-only inspection deliberately never opens a SessionStore (which would migrate). */
export function inspectDatabase(file: string, policy: DatabasePolicy): DatabaseInspection {
  const canonical = identity(file);
  return withReadOnlyDatabase(canonical, (db) => {
    if (existsSync(`${canonical}.json`)) {
      const manifest = JSON.parse(readFileSync(`${canonical}.json`, 'utf8')) as DatabaseBackup;
      if (
        !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
        digest(canonical) !== manifest.sha256 ||
        (existsSync(`${canonical}-wal`) && statSync(`${canonical}-wal`).size > 0)
      )
        throw new Error(`Backup checksum check failed: ${canonical}`);
    }
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
  });
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
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
  )
    throw new Error('Invalid backup directory');
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
  return withReadOnlyDatabase(file, (db) => {
    inspectDatabase(file, policy);
    return createDatabaseBackup(db, file, policy, 'manual');
  });
}

/** Only this database's complete, regular snapshots are eligible for the desktop restore picker. */
export function listDatabaseBackups(file: string): DatabaseBackup[] {
  const source = identity(file);
  const directory = `${source}.backups`;
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error('Invalid backup directory');
  const entries: DatabaseBackup[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^\d+-[a-f0-9-]{36}\.sqlite\.json$/.test(name)) continue;
    const manifest = path.join(directory, name);
    const ownedFile = manifest.slice(0, -5);
    try {
      const meta = lstatSync(manifest);
      const data = lstatSync(ownedFile);
      if (
        !meta.isFile() ||
        meta.isSymbolicLink() ||
        meta.size > 32768 ||
        !data.isFile() ||
        data.isSymbolicLink()
      )
        continue;
      const entry = JSON.parse(readFileSync(manifest, 'utf8')) as DatabaseBackup;
      if (
        entry.source !== source ||
        entry.file !== ownedFile ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        !['manual', 'migration'].includes(entry.reason)
      )
        continue;
      entries.push(entry);
    } catch {
      /* Unknown or incomplete files are not restore candidates. */
    }
  }
  return entries.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file),
  );
}
export function verifyDatabaseBackup(
  file: string,
  id: string,
  policy: DatabasePolicy,
): DatabaseBackup {
  if (!/^\d+-[a-f0-9-]{36}\.sqlite$/.test(id)) throw new Error('Invalid backup id');
  const entry = listDatabaseBackups(file).find((item) => path.basename(item.file) === id);
  if (!entry) throw new Error('Backup does not belong to this database');
  if (statSync(entry.file).size !== entry.bytes || digest(entry.file) !== entry.sha256)
    throw new Error('Backup size or checksum check failed');
  inspectDatabase(entry.file, policy);
  return entry;
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
      withReadOnlyDatabase(inspected.file, (db) => {
        db.prepare('VACUUM main INTO ?').run(stage);
      });
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
    const evidence = preserveCurrent(target, journal.candidate);
    writeJson(path.join(evidence.recoveryDirectory, 'preserved.json'), evidence);
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
