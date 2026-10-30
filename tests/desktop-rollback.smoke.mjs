// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

test(
  'a retained old desktop refuses a future schema; offline maintenance restores its compatible backup and opens the retained transcript',
  {
    skip: !process.env.UPGRADE_TEST_JOURNAL && 'needs UPGRADE_TEST_JOURNAL from an upgrade fixture',
    timeout: 120000,
  },
  async (t) => {
    const original = JSON.parse(
      await readFile(path.resolve(process.env.UPGRADE_TEST_JOURNAL), 'utf8'),
    );
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-rollback-'));
    let app;
    t.after(async () => {
      try {
        await app?.close();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
    // Upgrade evidence is read-only input. Clone every mutable application/profile/workspace tree
    // and rewrite its journal paths before exercising rollback or launching the retained desktop.
    const originals = [
      ...new Set([
        original.profile,
        original.workspace || path.dirname(path.dirname(original.database)),
        original.installDirectory,
      ]),
    ];
    const mappings = originals.map((source, index) => [
      path.resolve(source),
      path.join(root, `tree-${index}`),
    ]);
    // The upgrade smoke uninstalls the upgraded application when it ends; rollback restores from the backup inside
    // the upgrade directory and never reads the install directory, so a missing one is cloned as empty.
    for (const [source, target] of mappings)
      if (existsSync(source)) await cp(source, target, { recursive: true, dereference: true });
      else await mkdir(target, { recursive: true });
    mappings.sort((a, b) => b[0].length - a[0].length);
    const relocate = (value) => {
      if (typeof value === 'string' && path.isAbsolute(value)) {
        for (const [source, target] of mappings) {
          const relative = path.relative(source, value);
          if (
            relative === '' ||
            (!relative.startsWith('..' + path.sep) &&
              relative !== '..' &&
              !path.isAbsolute(relative))
          )
            return path.join(target, relative);
        }
      }
      if (Array.isArray(value)) return value.map(relocate);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, relocate(item)]),
        );
      return value;
    };
    const journal = relocate(original);
    const file = journal.journal;
    for (const mutable of [
      file,
      journal.directory,
      journal.profile,
      journal.database,
      journal.databaseBackup.file,
      journal.softwareBackup,
      journal.settingsBackup,
    ]) {
      const relative = path.relative(root, mutable);
      assert.ok(
        relative &&
          relative !== '..' &&
          !relative.startsWith('..' + path.sep) &&
          !path.isAbsolute(relative),
        'Rollback paths must belong to this private fixture',
      );
    }
    await writeFile(file, JSON.stringify(journal));
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
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
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
    await page.waitForFunction(() => document.querySelector('#prompt')?.disabled === false);
    try {
      await page.getByText('UPGRADE_PRESERVED_REPLY', { exact: true }).waitFor();
    } catch (error) {
      // Which workspace and session the restored desktop opened says whether the transcript is missing or elsewhere.
      const state = await page
        .evaluate(async () => {
          const snapshot = await window.yuantu.invoke({ type: 'snapshot' });
          const { workspace, currentSession, sessions, session, error, errorDetail } =
            snapshot.state ?? {};
          return {
            ok: snapshot.ok,
            workspace,
            currentSession,
            sessions: sessions?.map((item) => ({ id: item.id, title: item.title })),
            messages: session?.messages?.map((message) => String(message.content).slice(0, 80)),
            error,
            errorDetail,
          };
        })
        .catch((reason) => String(reason));
      console.error(
        'Restored desktop snapshot:',
        JSON.stringify({ expectedWorkspace: env.YUANTU_WORKSPACE, state }),
      );
      throw error;
    }
    const retained = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(retained.settings.hasKey, true);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), journal.current.version);
    assert.deepEqual(await readFile(path.join(journal.profile, 'model-settings.json')), settings);
  },
);
