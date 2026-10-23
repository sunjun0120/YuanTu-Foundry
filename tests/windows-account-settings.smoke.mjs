// @test-serial desktop-ui: Opens the real Electron window; never requests account initialization.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { tempRoot } from './temp-fixture.ts';

test(
  'sandbox accounts are offered above the composer and managed in settings once ready',
  { timeout: 60000 },
  async (t) => {
    let app;
    t.after(() => app?.close());
    const root = await tempRoot(t, 'yuantu-account-settings-');
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_SANDBOX: 'native',
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
    const prompt = page.locator('#sandbox-prompt');
    const section = page.locator('#sandbox-setup-section');
    if (process.platform !== 'win32') {
      assert.equal(await prompt.isHidden(), true);
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      assert.equal(await section.isHidden(), true);
      return;
    }
    // Ask the main process what the window should be drawing, then check that it draws exactly that.
    const view = await page.evaluate(async () => {
      const reply = await window.yuantu.sandboxSetup({ type: 'status' });
      return reply.ok ? reply.view : undefined;
    });
    if (view?.state !== 'uninitialized' && view?.state !== 'damaged' && view?.state !== 'ready') {
      // A missing or unreadable helper is an installation problem: neither surface mentions it.
      await page.waitForTimeout(1000);
      assert.equal(await prompt.isHidden(), true);
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      assert.equal(await section.isHidden(), true);
      return;
    }
    if (view.state !== 'ready') {
      // Setup is offered above the composer; clicking it would ask for UAC, which this smoke never does.
      await prompt.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sandbox-prompt-initialize').isDisabled(), false);
      await page.locator('#sandbox-prompt-dismiss').click();
      assert.equal(await prompt.isHidden(), true);
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      assert.equal(await section.isHidden(), true);
      return;
    }
    // Ready accounts: the settings section manages them, in the chosen language.
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await section.waitFor({ state: 'visible' });
    await page.locator('#ui-language').selectOption('en-US');
    await page.waitForFunction(
      () =>
        document.querySelector('#sandbox-setup-title').textContent === 'Windows sandbox accounts',
    );
    assert.equal(
      await page.locator('#sandbox-setup-uninstall').innerText(),
      'Uninstall sandbox accounts',
    );
  },
);
