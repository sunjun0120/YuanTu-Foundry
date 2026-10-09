import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { backupDatabase, restoreDatabase } from '../packages/storage/database-maintenance.ts';
import { SESSION_DATABASE_POLICY } from '../packages/storage/sqlite.ts';

const [mode, target, candidate] = process.argv.slice(2);
if (!target) throw new Error('missing isolated database');
const original = fs.writeFileSync;
fs.writeFileSync = ((file, data, ...args) => {
  const name = String(file);
  const backupManifest = name.includes('.sqlite.json.');
  const installedReceipt =
    name.includes('restore.json.') && JSON.parse(String(data)).phase === 'installed';
  if ((mode === 'backup-full' && backupManifest) || (mode !== 'backup-full' && installedReceipt)) {
    if (mode === 'restore-crash') process.exit(86);
    throw Object.assign(new Error('ENOSPC: injected isolated journal write failure'), {
      code: 'ENOSPC',
    });
  }
  return original(file, data, ...args);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();
try {
  if (mode === 'backup-full') backupDatabase(target, SESSION_DATABASE_POLICY);
  else restoreDatabase(target, candidate!, SESSION_DATABASE_POLICY);
  throw new Error('fault did not trigger');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
