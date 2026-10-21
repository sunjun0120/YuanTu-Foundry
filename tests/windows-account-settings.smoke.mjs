// @test-serial desktop-ui: Opens the real Electron settings page; never requests account initialization.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { tempRoot } from './temp-fixture.ts';

test(
  'account settings are translated and development installs cannot request UAC',
  { timeout: 60000 },
  async (t) => {
    let app;
    t.after(() => app?.close());
    const root = await tempRoot(t, 'yuantu-account-settings-');
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_SANDBOX: 'host',
      YUANTU_SESSION_TITLES: 'false',
      YUANTU_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE: '',
      YUANTU_SANDBOX_DEV_PROVISION: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    if (process.platform !== 'win32') {
      assert.equal(await page.locator('#sandbox-setup-section').isHidden(), true);
      return;
    }
    await page.locator('#sandbox-setup-section').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sandbox-setup-initialize').isDisabled(), true);
    assert.equal(await page.locator('#sandbox-setup-uninstall').isDisabled(), true);
    assert.equal(await page.locator('#sandbox-read-add').isDisabled(), true);
    assert.match(await page.locator('#sandbox-setup-feedback').innerText(), /签名安装版本/);
    await page.locator('#ui-language').selectOption('en-US');
    await page.waitForFunction(
      () =>
        document.querySelector('#sandbox-setup-title').textContent === 'Windows sandbox accounts',
    );
    assert.match(await page.locator('#sandbox-setup-feedback').innerText(), /signed release/);
    assert.equal(
      await page.locator('#sandbox-setup-uninstall').innerText(),
      'Uninstall sandbox accounts',
    );
    await page.locator('#sandbox-setup-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#sandbox-setup-refresh').disabled);
    assert.equal(await page.locator('#sandbox-setup-initialize').isDisabled(), true);
    const bounds = await page.locator('#sandbox-setup-section').boundingBox();
    assert.ok(bounds && bounds.width > 200 && bounds.height > 100);
  },
);
