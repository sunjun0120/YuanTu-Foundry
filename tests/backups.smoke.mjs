import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';

test(
  'desktop settings omit backups, ignore legacy daily opt-in and preserve manual restore safeguards',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-backup-ui-'));
    await mkdir(path.join(root, '.yuantu'));
    const file = path.join(root, '.yuantu', 'sessions.sqlite');
    let store = new SessionStore(file);
    const session = store.create(root);
    store.append(session.id, { role: 'user', content: 'BACKUP_ORIGINAL' });
    store.close();
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'backup-model',
      YUANTU_API_KEY: 'synthetic-backup-key',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    await writeFile(path.join(profile, 'backup-settings.json'), '{"enabled":true}');
    const app = await electron.launch({
      executablePath: electronPath,
      args: [path.resolve('dist/desktop/main.cjs'), `--user-data-dir=${profile}`],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator('#open-settings').click();
    assert.deepEqual(
      await page
        .locator('.settings-sidebar nav button')
        .evaluateAll((buttons) => buttons.map((button) => button.id)),
      ['general-settings', 'model-settings', 'workspace-maintenance-settings'],
    );
    assert.equal(await page.locator('#backup-settings-content,#backup-enabled').count(), 0);
    const initial = await page.evaluate(() => window.yuantu.backups({ type: 'get' }));
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.view.enabled, false);
    assert.equal(initial.view.backups.length, 0);
    const configuration = await page.evaluate(() =>
      window.yuantu.backups({ type: 'configure', enabled: true }),
    );
    assert.equal(configuration.ok, false);
    const created = await page.evaluate(() => window.yuantu.backups({ type: 'create' }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.view.backups.length, 1);
    const id = created.view.backups[0].id;
    store = new SessionStore(file);
    store.append(session.id, { role: 'user', content: 'BACKUP_NEWER' });
    store.close();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const cancelled = await page.evaluate(
      (id) => window.yuantu.backups({ type: 'restore', id }),
      id,
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.cancelled, true);
    store = new SessionStore(file);
    assert.equal(store.messages(session.id).length, 2);
    store.close();
    const rejected = await page.evaluate(() =>
      window.yuantu.backups({ type: 'restore', id: '../sessions.sqlite' }),
    );
    assert.equal(rejected.ok, false);
    const foreignPath = await page.evaluate(() =>
      window.yuantu.backups({ type: 'get', file: 'C:/arbitrary.sqlite' }),
    );
    assert.equal(foreignPath.ok, false);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const restored = await page.evaluate(
      (id) => window.yuantu.backups({ type: 'restore', id }),
      id,
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.ok(restored.recoveryDirectory);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    store = new SessionStore(file);
    assert.equal(store.messages(session.id).length, 1);
    store.close();
    store = new SessionStore(path.join(restored.recoveryDirectory, 'database.sqlite'));
    assert.equal(store.messages(session.id)[1].content, 'BACKUP_NEWER');
    store.close();
    await page.locator('#settings-back').click();
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    await page.locator('#messages').getByText('BACKUP_ORIGINAL', { exact: true }).waitFor();
    assert.equal(
      await page.locator('#messages').getByText('BACKUP_NEWER', { exact: true }).count(),
      0,
    );
  },
);
