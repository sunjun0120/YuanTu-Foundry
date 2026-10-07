import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
  offlineDatabaseOperation,
  beginDesktopRollback,
  type DatabaseBackup,
} from '../storage/database-maintenance.ts';
import { SESSION_DATABASE_POLICY } from '../storage/sqlite.ts';

export interface DesktopRelease {
  version: string;
  channel: string;
  maxSchemaVersion: number;
}
export interface UpgradeManifest extends DesktopRelease {
  format: 1;
  application: 'com.yuantu.agent';
  platform: 'win32';
  arch: 'x64';
  artifact: string;
  sha256: string;
  nodeVersion: string;
}
export interface StagedUpgrade {
  installer: string;
  journal: string;
  directory: string;
  manifest: UpgradeManifest;
  profile: string;
}
export interface UpgradeJournal extends StagedUpgrade {
  current: DesktopRelease;
  installDirectory: string;
  softwareBackup: string;
  database: string;
  databaseBackup: DatabaseBackup;
  workspace: string;
  rollbackSettings?: { stage: string; failed: string; completed: string[] };
  softwareFiles: Record<string, string>;
  settingsBackup: string;
  settingsFiles: Record<string, string>;
  phase:
    | 'prepared'
    | 'installing'
    | 'install-failed'
    | 'starting'
    | 'startup-failed'
    | 'completed'
    | 'rollback-started'
    | 'rolled-back';
  createdAt: string;
  error?: string;
  confirmedVersion?: string;
}
function hash(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const digest = createHash('sha256');
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) > 0)
      digest.update(bytes.subarray(0, count));
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function writeJournal(journal: UpgradeJournal): void {
  const stage = `${journal.journal}.${randomUUID()}.tmp`;
  writeFileSync(stage, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
  const fd = openSync(stage, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, journal.journal);
}
function version(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value))
    throw new Error('Unsupported release version; use three numeric components');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('Invalid release version');
  return parts;
}
function newer(candidate: string, current: string): boolean {
  const a = version(candidate),
    b = version(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}
function verify(file: string, manifest: UpgradeManifest): void {
  if (!lstatSync(file).isFile() || hash(file) !== manifest.sha256)
    throw new Error('Installer checksum mismatch or non-regular file');
}
export function checkUpgrade(file: string, current: DesktopRelease): UpgradeManifest {
  const m = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as UpgradeManifest;
  if (
    m.format !== 1 ||
    m.application !== 'com.yuantu.agent' ||
    m.platform !== 'win32' ||
    m.arch !== 'x64' ||
    m.channel !== current.channel ||
    m.artifact !== path.basename(file) ||
    !file.endsWith('-setup.exe') ||
    typeof m.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.maxSchemaVersion) ||
    m.maxSchemaVersion < current.maxSchemaVersion ||
    !newer(m.version, current.version)
  )
    throw new Error('Invalid or incompatible upgrade manifest');
  version(m.nodeVersion);
  verify(file, m);
  return m;
}
export function stageUpgrade(
  file: string,
  profile: string,
  current: DesktopRelease,
  confirmed?: UpgradeManifest,
): StagedUpgrade {
  const manifest = checkUpgrade(file, current);
  if (confirmed && !isDeepStrictEqual(manifest, confirmed))
    throw new Error('Installer no longer matches the confirmed manifest');
  const directory = path.join(realpathSync(profile), 'upgrades', randomUUID());
  mkdirSync(directory, { recursive: true });
  const installer = path.join(directory, manifest.artifact);
  copyFileSync(file, installer);
  verify(installer, manifest);
  return {
    installer,
    directory,
    manifest,
    profile: realpathSync(profile),
    journal: path.join(directory, 'upgrade.json'),
  };
}
function overlap(a: string, b: string): boolean {
  const inside = (root: string, file: string) => {
    const p = path.relative(root, file);
    return p === '' || (!p.startsWith(`..${path.sep}`) && p !== '..' && !path.isAbsolute(p));
  };
  return inside(a, b) || inside(b, a);
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) result[name] = hash(path.join(root, name));
      else throw new Error(`Maintenance snapshots refuse symbolic links: ${name}`);
    }
  }
  visit('');
  return result;
}
function verifyFiles(root: string, expected: Record<string, string>): void {
  const actual = files(root);
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(expected).sort())
  )
    throw new Error('Recovery snapshot checksum mismatch');
}
export function prepareUpgrade(
  staged: StagedUpgrade,
  installDirectory: string,
  database: string,
  current: DesktopRelease,
  workspace = path.dirname(path.dirname(database)),
): UpgradeJournal {
  verify(staged.installer, staged.manifest);
  const installed = realpathSync(installDirectory),
    db = realpathSync(database);
  workspace = realpathSync(workspace);
  if (overlap(installed, staged.profile) || overlap(installed, workspace))
    throw new Error('Application and user data directories must not overlap');
  if (!lstatSync(path.join(installed, 'YuanTu Agent.exe')).isFile())
    throw new Error('Invalid application directory');
  const policy = { ...SESSION_DATABASE_POLICY, maxVersion: current.maxSchemaVersion };
  const sourceBackup = offlineDatabaseOperation(db, () => backupDatabase(db, policy));
  // Upgrade recovery copies are not subject to routine migration backup retention.
  const backupFile = path.join(staged.directory, 'previous-database.sqlite');
  copyFileSync(sourceBackup.file, backupFile);
  copyFileSync(`${sourceBackup.file}.json`, `${backupFile}.json`);
  const databaseBackup = { ...sourceBackup, file: backupFile };
  const softwareBackup = path.join(staged.directory, 'previous-application');
  const softwareFiles = files(installed);
  cpSync(installed, softwareBackup, { recursive: true, errorOnExist: true, force: false });
  verifyFiles(softwareBackup, softwareFiles);
  const settingsBackup = path.join(staged.directory, 'previous-settings');
  mkdirSync(settingsBackup);
  for (const name of [
    'model-settings.json',
    'ui-settings.json',
    'permission-policy.json',
    'mcp-oauth',
  ]) {
    const source = path.join(staged.profile, name);
    if (existsSync(source)) cpSync(source, path.join(settingsBackup, name), { recursive: true });
  }
  const settingsFiles = files(settingsBackup);
  const journal: UpgradeJournal = {
    ...staged,
    current,
    installDirectory: installed,
    softwareBackup,
    softwareFiles,
    settingsBackup,
    settingsFiles,
    database: db,
    databaseBackup,
    workspace,
    phase: 'prepared',
    createdAt: new Date().toISOString(),
  };
  writeJournal(journal);
  return journal;
}
export interface UpgradeOperations {
  install(journal: UpgradeJournal): Promise<number>;
  launch(journal: UpgradeJournal): Promise<void>;
  ready(journal: UpgradeJournal): Promise<boolean>;
}
export async function runUpgrade(
  journal: UpgradeJournal,
  operations: UpgradeOperations,
): Promise<void> {
  try {
    verify(journal.installer, journal.manifest);
    journal.phase = 'installing';
    delete journal.error;
    writeJournal(journal);
    const code = await operations.install(journal);
    if (code !== 0) throw new Error(`Installer exited with code ${code}`);
    journal.phase = 'starting';
    writeJournal(journal);
    await operations.launch(journal);
    if (!(await operations.ready(journal)))
      throw new Error('Installed application did not confirm Host readiness');
    const ready = JSON.parse(readFileSync(`${journal.journal}.ready`, 'utf8')) as {
      version: string;
    };
    if (ready.version !== journal.manifest.version)
      throw new Error('Installed version did not confirm startup');
    journal.confirmedVersion = ready.version;
    journal.phase = 'completed';
    writeJournal(journal);
  } catch (error) {
    journal.error = String(error);
    journal.phase = journal.phase === 'starting' ? 'startup-failed' : 'install-failed';
    writeJournal(journal);
  }
}
export function acknowledgeUpgrade(file: string, runningVersion: string): boolean {
  if (!existsSync(file)) return false;
  const journal = JSON.parse(readFileSync(file, 'utf8')) as UpgradeJournal;
  if (journal.manifest.version !== runningVersion || journal.phase !== 'starting') return false;
  writeFileSync(`${file}.ready`, JSON.stringify({ version: runningVersion, pid: process.pid }), {
    flag: 'wx',
    mode: 0o600,
  });
  return true;
}
export function rollbackUpgrade(file: string): UpgradeJournal {
  const journal = JSON.parse(readFileSync(file, 'utf8')) as UpgradeJournal;
  if (existsSync(`${file}.pid`)) {
    const pid = Number(readFileSync(`${file}.pid`, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid application PID in recovery record');
    try {
      process.kill(pid, 0);
      throw new Error('Close the upgraded desktop before rollback');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  if (
    journal.journal !== path.resolve(file) ||
    realpathSync(journal.softwareBackup) !==
      path.join(realpathSync(journal.directory), 'previous-application')
  )
    throw new Error('Invalid recovery record');
  const policy = { ...SESSION_DATABASE_POLICY, maxVersion: journal.current.maxSchemaVersion };
  inspectDatabase(journal.databaseBackup.file, policy);
  if (!lstatSync(path.join(journal.softwareBackup, 'YuanTu Agent.exe')).isFile())
    throw new Error('Previous application is unavailable');
  verifyFiles(journal.softwareBackup, journal.softwareFiles);
  verifyFiles(journal.settingsBackup, journal.settingsFiles);
  if (journal.phase === 'rolled-back' && !existsSync(`${journal.database}.desktop-rollback.json`))
    return journal;
  if (!journal.rollbackSettings) {
    const stage = path.join(journal.directory, `rollback-settings-${randomUUID()}`);
    const failed = path.join(journal.directory, `failed-settings-${randomUUID()}`);
    cpSync(journal.settingsBackup, stage, { recursive: true });
    verifyFiles(stage, journal.settingsFiles);
    mkdirSync(failed);
    journal.rollbackSettings = { stage, failed, completed: [] };
  }
  const finishRecovery = beginDesktopRollback(journal.database, journal.journal);
  journal.phase = 'rollback-started';
  writeJournal(journal);
  restoreDatabase(journal.database, journal.databaseBackup.file, policy);
  for (const name of [
    'model-settings.json',
    'ui-settings.json',
    'permission-policy.json',
    'mcp-oauth',
  ]) {
    if (journal.rollbackSettings.completed.includes(name)) continue;
    const live = path.join(journal.profile, name);
    const stage = path.join(journal.rollbackSettings.stage, name);
    const failed = path.join(journal.rollbackSettings.failed, name);
    if (
      existsSync(live) &&
      !existsSync(failed) &&
      (existsSync(stage) || !existsSync(path.join(journal.settingsBackup, name)))
    )
      renameSync(live, failed);
    // A rename is atomic; if a crash happened after it, its source is already absent on retry.
    if (existsSync(stage)) renameSync(stage, live);
    journal.rollbackSettings.completed.push(name);
    writeJournal(journal);
  }
  // Preserve the installed tree; launch the complete old tree independently. Do not rewrite NSIS registration.
  journal.phase = 'rolled-back';
  writeJournal(journal);
  finishRecovery();
  return journal;
}
