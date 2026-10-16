import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  backupDatabase,
  initializeDatabase,
  inspectDatabase,
  offlineDatabaseOperation,
  recoverDatabase,
  restoreDatabase,
} from '../packages/storage/database-maintenance.ts';

const policy = { application: 'test', applicationId: 42, format: 1, maxVersion: 1 };

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'maintenance-readers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'target.sqlite');
  const candidate = path.join(root, 'candidate.sqlite');
  for (const [name, value] of [
    [file, 'original'],
    [candidate, 'candidate'],
  ]) {
    const db = new DatabaseSync(name!);
    db.exec('CREATE TABLE sessions (id TEXT); PRAGMA user_version=1');
    db.prepare('INSERT INTO sessions VALUES (?)').run(value!);
    db.close();
  }
  return { root, file, candidate };
}

function beforePrepare(sql: string, action: () => void) {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (statement) {
    if (statement === sql) {
      DatabaseSync.prototype.prepare = prepare;
      action();
    }
    return prepare.call(this, statement);
  };
  return () => {
    DatabaseSync.prototype.prepare = prepare;
  };
}

for (const operation of ['inspect', 'backup'] as const) {
  test(`a raw ${operation} reader blocks replacement until its SQLite connection closes`, (t) => {
    const { file, candidate } = fixture(t);
    let conflict: unknown;
    const restorePrepare = beforePrepare(
      operation === 'inspect' ? 'PRAGMA integrity_check' : 'VACUUM main INTO ?',
      () => {
        try {
          restoreDatabase(file, candidate, policy);
        } catch (error) {
          conflict = error;
        }
      },
    );
    try {
      if (operation === 'inspect') inspectDatabase(file, policy);
      else backupDatabase(file, policy);
    } finally {
      restorePrepare();
    }
    assert.ok(conflict instanceof Error, 'replacement must be refused while reader is open');
    assert.match(conflict.message, /active reader\/writer/);
    assert.equal(
      fs.existsSync(`${file}.users`) && fs.readdirSync(`${file}.users`).length > 0,
      false,
    );
    assert.equal(restoreDatabase(file, candidate, policy).phase, 'completed');
  });
}

test('failed inspection closes and unregisters its reader before a later restore', (t) => {
  const { file, candidate } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA application_id=99');
  db.close();
  let registered = false;
  const restorePrepare = beforePrepare('PRAGMA application_id', () => {
    registered = fs.existsSync(`${file}.users`) && fs.readdirSync(`${file}.users`).length > 0;
  });
  try {
    assert.throws(() => inspectDatabase(file, policy), /another application/);
  } finally {
    restorePrepare();
  }
  assert.equal(registered, true, 'the reader must be registered before validation can fail');
  assert.equal(fs.existsSync(`${file}.users`) && fs.readdirSync(`${file}.users`).length > 0, false);
  assert.equal(restoreDatabase(file, candidate, policy).phase, 'completed');
});

test('offline and initialization owners can inspect and back up without reacquiring their gate', (t) => {
  const { file } = fixture(t);
  const backup = offlineDatabaseOperation(file, () => backupDatabase(file, policy));
  assert.equal(backup.version, 1);
  assert.equal(initializeDatabase(file, () => inspectDatabase(file, policy)).version, 1);
});

test('backup stage inspection leaves no registration artifacts beside published snapshots', (t) => {
  const { file } = fixture(t);
  const backup = backupDatabase(file, policy);
  const name = path.basename(backup.file);
  assert.deepEqual(fs.readdirSync(`${file}.backups`).sort(), [name, `${name}.json`].sort());
});

test('a partial owner-record write removes only the maintenance lock just created', (t) => {
  const { file } = fixture(t);
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = ((name, data, ...args) => {
    if (typeof name === 'number') {
      writeFileSync(name, String(data).slice(0, 4));
      throw Object.assign(new Error('ENOSPC: partial lock owner write'), { code: 'ENOSPC' });
    }
    return writeFileSync(name, data, ...args);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => initializeDatabase(file, () => {}), /ENOSPC/);
  } finally {
    fs.writeFileSync = writeFileSync;
    syncBuiltinESMExports();
  }
  assert.equal(fs.existsSync(`${file}.maintenance-lock`), false);
  initializeDatabase(file, () => {});
});

test('a live maintenance owner timeout does not recommend deleting its lock', (t) => {
  const { file } = fixture(t);
  const lock = `${file}.maintenance-lock`;
  const owner = `${process.pid}:12345678-1234-1234-1234-123456789abc`;
  fs.writeFileSync(lock, owner);
  const now = Date.now;
  let tick = 0;
  Date.now = () => ++tick * 6000;
  try {
    assert.throws(
      () => initializeDatabase(file, () => {}),
      (error: Error) => {
        assert.match(error.message, /maintenance.*active|active.*maintenance/i);
        assert.doesNotMatch(error.message, /remov|delet/i);
        return true;
      },
    );
  } finally {
    Date.now = now;
  }
  assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});

test('a lock released during timeout inspection is retried rather than reported as missing', (t) => {
  const { file } = fixture(t);
  const lock = `${file}.maintenance-lock`;
  fs.writeFileSync(lock, `${process.pid}:12345678-1234-1234-1234-123456789abc`);
  const readFileSync = fs.readFileSync;
  const now = Date.now;
  let tick = 0;
  Date.now = () => ++tick * 6000;
  fs.readFileSync = ((name, ...args) => {
    if (String(name) === lock) {
      fs.readFileSync = readFileSync;
      syncBuiltinESMExports();
      fs.rmSync(lock);
    }
    return readFileSync(name, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(
      initializeDatabase(file, () => 'admitted'),
      'admitted',
    );
  } finally {
    Date.now = now;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
  }
});

test('recovery preserves failed replacement evidence with its identifying metadata', (t) => {
  const { root, file, candidate } = fixture(t);
  const receipt = restoreDatabase(file, candidate, policy);
  fs.writeFileSync(`${file}.restore.json`, JSON.stringify({ ...receipt, phase: 'installed' }));
  assert.equal(recoverDatabase(file).phase, 'rolled-back');
  const evidence = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .find((name) => name.startsWith(`${file}.recovery-`) && name !== receipt.recoveryDirectory)!;
  assert.ok(evidence);
  assert.ok(
    fs.existsSync(path.join(evidence, 'preserved.json')),
    'preserved evidence needs metadata',
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(evidence, 'preserved.json'), 'utf8'));
  assert.equal(metadata.target, file);
  assert.equal(metadata.candidate, candidate);
  assert.equal(metadata.recoveryDirectory, evidence);
  assert.equal(metadata.originals[0].suffix, '');
  assert.match(metadata.originals[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(evidence, 'database.sqlite')));
});

test('inspection accepts this build’s schema version and refuses one from the future', (t) => {
  const { file } = fixture(t);
  // The fixture stamps user_version=1, which is exactly policy.maxVersion: the boundary is accepted, and
  // measuring it here is what keeps the comparison honest about `>` rather than `>=`.
  assert.equal(inspectDatabase(file, policy).version, policy.maxVersion);
  // One past it was written by a newer build. Inspection is the single place that decision is made, so an
  // accepted candidate here would let a later restore replace this database with a schema it cannot read.
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${policy.maxVersion + 1}`);
  db.close();
  assert.throws(
    () => inspectDatabase(file, policy),
    new RegExp(
      `Unsupported session database version: ${policy.maxVersion + 1} \\(maximum ${policy.maxVersion}\\)`,
    ),
  );
});

test('releasing the gate does not delete a lock another owner replaced', (t) => {
  const { file } = fixture(t);
  const lock = `${file}.maintenance-lock`;
  const replacement = `${process.pid}:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
  const held = initializeDatabase(file, () => {
    // A second owner takes the gate while this one is still inside it, so the name now holds a *different*
    // file. Removing that lock on the way out would strip a live owner of its only claim to the database —
    // the reason the release path compares device and inode instead of trusting the path.
    fs.rmSync(lock);
    fs.writeFileSync(lock, replacement);
    return 'held';
  });
  assert.equal(held, 'held');
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
});

test('releasing the gate does not delete a lock whose owner record is no longer ours', (t) => {
  const { file } = fixture(t);
  const lock = `${file}.maintenance-lock`;
  const other = `${process.pid}:cccccccc-cccc-cccc-cccc-cccccccccccc`;
  initializeDatabase(file, () => {
    // Same file, rewritten in place: the inode still matches, so only the owner record can tell this holder
    // that the claim it is about to remove is somebody else's.
    fs.writeFileSync(lock, other);
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), other);
});
