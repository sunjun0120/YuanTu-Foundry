import path from 'node:path';
import {
  backupDatabase,
  listDatabaseBackups,
  restoreDatabase,
  verifyDatabaseBackup,
} from '../../packages/storage/database-maintenance.ts';
import { SESSION_DATABASE_POLICY } from '../../packages/storage/sqlite.ts';
import type { BackupEntry } from './backup-contract.ts';

export type BackupAction = 'list' | 'create' | 'verify' | 'restore';
export interface BackupResult {
  backups: BackupEntry[];
  recoveryDirectory?: string;
}
export function databaseBackupAction(
  file: string,
  operation: BackupAction,
  id?: string,
): BackupResult {
  let recoveryDirectory: string | undefined;
  if (operation === 'create') backupDatabase(file, SESSION_DATABASE_POLICY);
  else if (operation === 'verify' || operation === 'restore') {
    const entry = verifyDatabaseBackup(file, id ?? '', SESSION_DATABASE_POLICY);
    if (operation === 'restore')
      recoveryDirectory = restoreDatabase(
        file,
        entry.file,
        SESSION_DATABASE_POLICY,
      ).recoveryDirectory;
  } else if (operation !== 'list') throw new Error('Unknown backup operation');
  const backups = listDatabaseBackups(file).map(({ file: snapshot, createdAt, bytes }) => ({
    id: path.basename(snapshot),
    createdAt,
    bytes,
  }));
  return { backups, ...(recoveryDirectory ? { recoveryDirectory } : {}) };
}
// Bundled as a separate ordinary-Node entrypoint; importing the source in tests has no side effects.
if (process.argv[2] === '--database-backup') {
  try {
    console.log(
      JSON.stringify(
        databaseBackupAction(process.argv[3]!, process.argv[4] as BackupAction, process.argv[5]),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
