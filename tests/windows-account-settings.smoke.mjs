// @test-serial desktop-ui: Opens the real Electron settings page; never requests account initialization.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { tempRoot } from './temp-fixture.ts';

test(
  'account settings are translated and an uninitialized install can request setup',
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
    await page.waitForFunction(
      () =>
        /未初始化|无法读取/.test(
          document.querySelector('#sandbox-setup-feedback')?.textContent ?? '',
        ),
      undefined,
      { timeout: 15000 },
    );
    // Initialization is offered on an unpackaged development build too; clicking it would ask for UAC, which
    // this smoke never does. Uninstall and the read-root list stay hidden until accounts exist.
    assert.equal(await page.locator('#sandbox-setup-initialize').isDisabled(), false);
    assert.equal(await page.locator('#sandbox-setup-uninstall').isHidden(), true);
    assert.equal(await page.locator('#sandbox-read-advanced').isHidden(), true);
    assert.match(await page.locator('#sandbox-setup-feedback').innerText(), /未初始化|无法读取/);
    await page.locator('#ui-language').selectOption('en-US');
    await page.waitForFunction(
      () =>
        document.querySelector('#sandbox-setup-title').textContent === 'Windows sandbox accounts',
    );
    assert.match(
      await page.locator('#sandbox-setup-feedback').innerText(),
      /not been initialized|cannot read/i,
    );
    assert.equal(
      await page.locator('#sandbox-setup-initialize').innerText(),
      'Initialize as administrator',
    );
    const bounds = await page.locator('#sandbox-setup-section').boundingBox();
    assert.ok(bounds && bounds.width > 200 && bounds.height > 100);
  },
);
