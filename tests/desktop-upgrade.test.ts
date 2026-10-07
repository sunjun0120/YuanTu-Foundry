import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  checkUpgrade,
  stageUpgrade,
  prepareUpgrade,
  runUpgrade,
  acknowledgeUpgrade,
  rollbackUpgrade,
} from '../packages/maintenance/desktop-upgrade.ts';
import {
  SessionStore,
  SESSION_DATABASE_POLICY,
  SCHEMA_VERSION,
} from '../packages/storage/sqlite.ts';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'yuantu-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installDirectory = path.join(root, '旧版 程序');
  const profile = path.join(root, '用户 profile');
  const workspace = path.join(root, '用户 workspace');
  for (const dir of [installDirectory, profile, path.join(workspace, '.yuantu')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(installDirectory, 'YuanTu Agent.exe'), 'old application');
  writeFileSync(path.join(profile, 'model-settings.json'), '{"encrypted":"fixture"}');
  const database = path.join(workspace, '.yuantu/sessions.sqlite');
  const store = new SessionStore(database);
  const session = store.create(workspace);
  store.close();
  const file = path.join(root, 'YuanTu-Agent-0.2.0-windows-x64-setup.exe');
  writeFileSync(file, 'fixture installer');
  const manifest = {
    format: 1,
    application: 'com.yuantu.agent',
    version: '0.2.0',
    channel: 'manual',
    platform: 'win32',
    arch: 'x64',
    artifact: path.basename(file),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    maxSchemaVersion: SCHEMA_VERSION + 1,
    nodeVersion: '24.19.0',
  };
  const save = () => writeFileSync(`${file}.json`, JSON.stringify(manifest));
  save();
  return {
    root,
    installDirectory,
    profile,
    workspace,
    database,
    session,
    file,
    manifest,
    save,
    current: {
      version: '0.1.0',
      channel: 'manual',
      maxSchemaVersion: SESSION_DATABASE_POLICY.maxVersion,
    },
  };
}

test('upgrade validates identity, version, channel and complete checksum before stopping anything', (t) => {
  const f = fixture(t);
  assert.equal(checkUpgrade(f.file, f.current).version, '0.2.0');
  for (const patch of [
    { version: '0.1.0' },
    { version: 'garbage' },
    { application: 'another.app' },
    { channel: 'experimental' },
    { artifact: '../outside.exe' },
  ]) {
    const original = { ...f.manifest };
    Object.assign(f.manifest, patch);
    f.save();
    assert.throws(() => checkUpgrade(f.file, f.current));
    Object.assign(f.manifest, original);
    f.save();
  }
  writeFileSync(f.file, 'incomplete download');
  assert.throws(() => checkUpgrade(f.file, f.current), /checksum/i);
});

test('staging and preparation preserve software, settings and a compatible database', (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  writeFileSync(f.file, 'changed original after selection');
  const journal = prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  assert.equal(
    readFileSync(path.join(journal.softwareBackup, 'YuanTu Agent.exe'), 'utf8'),
    'old application',
  );
  assert.equal(
    readFileSync(path.join(f.profile, 'model-settings.json'), 'utf8'),
    '{"encrypted":"fixture"}',
  );
  assert.equal(journal.databaseBackup.version, f.current.maxSchemaVersion);
});

test('installer and first startup failures retain recoverable states', async (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  const journal = prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  await runUpgrade(journal, {
    install: async () => 7,
    launch: async () => {
      throw new Error('must not launch');
    },
    ready: async () => false,
  });
  assert.equal(JSON.parse(readFileSync(staged.journal, 'utf8')).phase, 'install-failed');
  await runUpgrade(journal, {
    install: async () => 0,
    launch: async () => {},
    ready: async () => false,
  });
  assert.equal(JSON.parse(readFileSync(staged.journal, 'utf8')).phase, 'startup-failed');
  assert.equal(acknowledgeUpgrade(staged.journal, 'wrong-version'), false);
});

test('startup confirms only the selected version; rollback preserves newer schema and restores the old data', async (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  const journal = prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  await runUpgrade(journal, {
    install: async () => 0,
    launch: async () => {
      assert.equal(acknowledgeUpgrade(staged.journal, '0.2.0'), true);
    },
    ready: async () => true,
  });
  assert.equal(JSON.parse(readFileSync(staged.journal, 'utf8')).phase, 'completed');
  const db = new DatabaseSync(f.database);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => new SessionStore(f.database), /version/);
  const restored = rollbackUpgrade(staged.journal);
  assert.equal(restored.phase, 'rolled-back');
  const store = new SessionStore(f.database);
  assert.ok(store.get(f.session.id));
  store.close();
});

test('tampered staged installers refuse preparation', (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  writeFileSync(staged.installer, 'changed staged installer');
  assert.throws(
    () => prepareUpgrade(staged, f.installDirectory, f.database, f.current),
    /checksum/,
  );
});

test('preparation refuses active databases and application/profile overlap; recovery detects damaged software', (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  const live = new SessionStore(f.database);
  try {
    assert.throws(
      () => prepareUpgrade(staged, f.installDirectory, f.database, f.current),
      /active/,
    );
  } finally {
    live.close();
  }
  const journal = prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  writeFileSync(path.join(journal.softwareBackup, 'YuanTu Agent.exe'), 'damaged old application');
  assert.throws(() => rollbackUpgrade(staged.journal), /checksum/);
  const overlap = stageUpgrade(f.file, f.installDirectory, f.current);
  assert.throws(
    () => prepareUpgrade(overlap, f.installDirectory, f.database, f.current),
    /overlap/,
  );
});

test('rollback refuses an active upgraded desktop and restores encrypted profile files after format changes', (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  const journal = prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  writeFileSync(`${staged.journal}.pid`, String(process.pid));
  assert.throws(() => rollbackUpgrade(staged.journal), /Close.*desktop/);
  rmSync(`${staged.journal}.pid`);
  writeFileSync(path.join(f.profile, 'model-settings.json'), '{"new-format":"upgraded"}');
  rollbackUpgrade(staged.journal);
  assert.equal(
    readFileSync(path.join(f.profile, 'model-settings.json'), 'utf8'),
    '{"encrypted":"fixture"}',
  );
  assert.ok(journal.softwareFiles['YuanTu Agent.exe']);
});

test('staging refuses a different valid installer substituted while its confirmation was open', (t) => {
  const f = fixture(t);
  const confirmed = checkUpgrade(f.file, f.current);
  writeFileSync(f.file, 'a different valid application');
  f.manifest.sha256 = createHash('sha256').update(readFileSync(f.file)).digest('hex');
  f.manifest.version = '0.3.0';
  f.save();
  assert.throws(() => stageUpgrade(f.file, f.profile, f.current, confirmed), /confirmed/);
});

test('release manifests describe the selected built artifact, including its own schema and Node runtime', (t) => {
  const f = fixture(t);
  const output = path.join(f.root, 'independent-build');
  const app = path.join(output, 'win-unpacked/resources/app');
  const runtime = path.join(output, 'win-unpacked/resources/runtime');
  mkdirSync(path.join(app, 'dist/desktop'), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  writeFileSync(
    path.join(app, 'dist/desktop/release.json'),
    JSON.stringify({ maxSchemaVersion: 20 }),
  );
  writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({ nodeVersion: '24.1.0' }));
  const artifact = path.join(output, 'YuanTu-Agent-0.4.0-windows-x64-setup.exe');
  writeFileSync(artifact, 'older standalone build');
  const result = spawnSync(process.execPath, ['scripts/write-release-manifest.mjs', output], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(`${artifact}.json`, 'utf8'));
  assert.equal(manifest.maxSchemaVersion, 20);
  assert.equal(manifest.nodeVersion, '24.1.0');
});

test('application directories nested anywhere in the workspace refuse upgrade preparation', (t) => {
  const f = fixture(t);
  const installed = path.join(f.workspace, 'app');
  mkdirSync(installed);
  writeFileSync(path.join(installed, 'YuanTu Agent.exe'), 'old app');
  assert.throws(
    () =>
      prepareUpgrade(stageUpgrade(f.file, f.profile, f.current), installed, f.database, f.current),
    /overlap/,
  );
});

test('rollback preserves and removes settings that did not exist before upgrade', (t) => {
  const f = fixture(t);
  const staged = stageUpgrade(f.file, f.profile, f.current);
  prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  writeFileSync(path.join(f.profile, 'ui-settings.json'), 'new format created after upgrade');
  rollbackUpgrade(staged.journal);
  assert.equal(fs.existsSync(path.join(f.profile, 'ui-settings.json')), false);
});

test('interrupted profile restoration blocks every normal Store open and can resume without losing the newer profile', (t) => {
  const f = fixture(t);
  const ui = path.join(f.profile, 'ui-settings.json');
  writeFileSync(ui, 'old-ui');
  const staged = stageUpgrade(f.file, f.profile, f.current);
  prepareUpgrade(staged, f.installDirectory, f.database, f.current);
  writeFileSync(ui, 'new-ui');
  const copy = fs.cpSync,
    rename = fs.renameSync;
  t.mock.method(
    fs,
    'cpSync',
    (from: string | URL, to: string | URL, options: fs.CopySyncOptions) => {
      if (String(to) === ui) throw new Error('injected profile install failure');
      return copy(from, to, options);
    },
  );
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === ui) throw new Error('injected profile install failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => rollbackUpgrade(staged.journal), /injected/);
    assert.throws(
      () => new SessionStore(f.database),
      /rollback.*interrupted|recovery.*incomplete/i,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  rollbackUpgrade(staged.journal);
  assert.equal(readFileSync(ui, 'utf8'), 'old-ui');
  const store = new SessionStore(f.database);
  store.close();
  const backups = fs
    .readdirSync(staged.directory)
    .filter((name) => name.startsWith('failed-settings'));
  assert.ok(
    backups.some(
      (name) =>
        fs.existsSync(path.join(staged.directory, name, 'ui-settings.json')) &&
        readFileSync(path.join(staged.directory, name, 'ui-settings.json'), 'utf8') === 'new-ui',
    ),
  );
});
