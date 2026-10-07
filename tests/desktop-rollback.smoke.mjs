import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

test(
  'a retained old desktop refuses a future schema; offline maintenance restores its compatible backup and opens the retained transcript',
  { skip: !process.env.UPGRADE_TEST_JOURNAL, timeout: 120000 },
  async (t) => {
    const file = path.resolve(process.env.UPGRADE_TEST_JOURNAL);
    assert.ok(
      file.startsWith(path.resolve('.scratch') + path.sep),
      'Rollback smoke must only use isolated evidence',
    );
    const journal = JSON.parse(await readFile(file, 'utf8'));
    assert.notEqual(
      journal.phase,
      'rolled-back',
      'Use a fresh completed upgrade record for rollback smoke',
    );
    const executable = path.join(journal.softwareBackup, 'YuanTu Agent.exe');
    const settings = await readFile(path.join(journal.profile, 'model-settings.json'));
    const db = new DatabaseSync(journal.database);
    db.exec(`PRAGMA user_version=${journal.current.maxSchemaVersion + 1}`);
    db.close();
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: journal.workspace || path.dirname(path.dirname(journal.database)),
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const launch = async () => {
      const launched = await electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${journal.profile}`],
        cwd: journal.softwareBackup,
        env,
      });
      launched.process().stderr?.on('data', (chunk) => process.stderr.write(`[rollback] ${chunk}`));
      await launched.evaluate(({ dialog }) => {
        dialog.showErrorBox = (title, message) =>
          console.error(`ROLLBACK_NATIVE_ERROR ${title}: ${message}`);
      });
      return launched;
    };
    let app;
    t.after(async () => {
      await app?.close();
    });
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForFunction(async () =>
      JSON.stringify(await window.yuantu.invoke({ type: 'snapshot' })).includes(
        'Unsupported session database version',
      ),
    );
    assert.equal(await page.locator('#prompt').isDisabled(), true);
    await app.close();
    app = undefined;
    const result = await promisify(execFile)(
      path.join(journal.directory, 'maintenance-node.exe'),
      [
        path.join(journal.directory, 'upgrade-worker.cjs'),
        'rollback',
        file,
        '--offline',
        '--no-launch',
      ],
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).phase, 'rolled-back');
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.getByText('UPGRADE_PRESERVED_REPLY', { exact: true }).waitFor();
    const retained = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(retained.settings.hasKey, true);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), journal.current.version);
    assert.deepEqual(await readFile(path.join(journal.profile, 'model-settings.json')), settings);
  },
);
