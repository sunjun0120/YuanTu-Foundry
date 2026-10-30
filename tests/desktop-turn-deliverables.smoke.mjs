// @test-serial desktop-ui: Launches a real Electron window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { translate } from '../apps/desktop/i18n.ts';

test(
  'each turn shows its own deliverables after the answer, opens previews, and survives reload',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-turn-deliverables-ui-'));
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, '.yuantu'));
    await writeFile(path.join(root, 'report.md'), '# Current report\nPreview is available.\n');
    await writeFile(
      path.join(root, 'report.html'),
      '<!doctype html><title>HTML report</title><h1>Rendered report</h1><script>document.body.dataset.ready="yes"</script>',
    );
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    try {
      for (const [index, description] of ['First report', 'Revised report', null].entries()) {
        store.append(session.id, { role: 'user', content: `QUESTION_${index}` });
        const runId = store.beginRun(session.id);
        if (description)
          store.recordEvent(session.id, 'deliverable.presented', {
            files: [
              {
                path: 'report.md',
                description,
                bytes: 10,
                sha256: 'a'.repeat(64),
                at: '2026-10-29T00:00:00Z',
              },
              ...(index === 0
                ? [
                    {
                      path: 'report.html',
                      description: 'HTML report',
                      bytes: 100,
                      sha256: 'b'.repeat(64),
                      at: '2026-10-30T00:00:00Z',
                    },
                  ]
                : []),
            ],
          });
        store.append(session.id, { role: 'assistant', content: `ANSWER_${index}`, toolCalls: [] });
        store.finishRun({
          sessionId: session.id,
          runId,
          status: 'completed',
          text: `ANSWER_${index}`,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }
    } finally {
      store.close();
    }
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_SANDBOX: 'host',
      YUANTU_SESSION_TITLES: 'false',
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
    await app.evaluate(({ shell }) => {
      globalThis.__shellOpens = [];
      globalThis.__folderReveals = [];
      shell.showItemInFolder = (file) => globalThis.__folderReveals.push(file);
      shell.openPath = async (file) => {
        globalThis.__shellOpens.push(file);
        return '';
      };
      shell.openExternal = async (url) => {
        globalThis.__shellOpens.push(url);
      };
    });
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace')?.disabled);
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    const cards = page.locator('#messages > .deliverables-panel');
    await cards.nth(1).waitFor();
    assert.equal(await cards.count(), 2);
    assert.deepEqual(await cards.locator('.deliverable-title').allTextContents(), [
      'First report',
      'HTML report',
      'Revised report',
    ]);
    assert.deepEqual(
      await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      [
        translate('ui.turnDeliverablesTitle', 'zh-CN'),
        translate('ui.turnDeliverablesTitle', 'zh-CN'),
      ],
    );
    assert.equal(await cards.locator('.deliverable-open').count(), 3);
    assert.equal(await cards.locator('.deliverable-folder').count(), 3);
    assert.equal(
      await cards.locator('.deliverable-view').first().innerText(),
      translate('ui.viewInSidebar', 'zh-CN'),
    );
    assert.equal(await cards.locator('[data-kind="html"]').count(), 1);
    assert.equal(
      await cards
        .getByRole('button', { name: translate('ui.openWithDefaultApp', 'zh-CN'), exact: true })
        .count(),
      0,
    );
    const order = await page.locator('#messages > *').evaluateAll((nodes) =>
      nodes
        .map((node) => {
          if (node.classList.contains('deliverables-panel')) return 'DELIVERABLES';
          return node.textContent.match(/(?:QUESTION|ANSWER)_\d/)?.[0];
        })
        .filter(Boolean),
    );
    assert.deepEqual(order, [
      'QUESTION_0',
      'ANSWER_0',
      'DELIVERABLES',
      'QUESTION_1',
      'ANSWER_1',
      'DELIVERABLES',
      'QUESTION_2',
      'ANSWER_2',
    ]);
    const markdown = cards.first().locator('.deliverable[data-path="report.md"]');
    const html = cards.first().locator('.deliverable[data-path="report.html"]');
    assert.equal(await page.locator('#workspace-panel').isVisible(), false);
    await html.locator('.deliverable-folder').click();
    assert.equal(
      await page.locator('#workspace-panel').isVisible(),
      false,
      'revealing the folder does not open the card',
    );
    const reveals = await app.evaluate(() => globalThis.__folderReveals);
    assert.equal(reveals.length, 1);
    assert.equal(path.basename(reveals[0]), 'report.html');
    // The card's empty corner opens it, as well as its title and icon area.
    await markdown.locator('.deliverable-open').click({ position: { x: 8, y: 8 } });
    await page.waitForFunction(() =>
      document.querySelector('#workspace-preview-body')?.textContent.includes('Current report'),
    );
    await html.locator('.deliverable-open').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.browser-address')?.value === 'report.html',
    );
    assert.equal(await page.locator('.browser-address').getAttribute('readonly'), '');
    let guest;
    for (let attempt = 0; attempt < 150 && !guest; attempt++) {
      guest = app.windows().find((candidate) => candidate.url().startsWith('data:text/html'));
      if (!guest) await page.waitForTimeout(50);
    }
    assert.ok(guest, 'HTML renders in the native right-side browser');
    await guest.waitForFunction(() => document.body.dataset.ready === 'yes');
    assert.equal(await guest.locator('h1').innerText(), 'Rendered report');
    assert.equal(await guest.evaluate(() => typeof require), 'undefined');
    assert.equal(await guest.evaluate(() => typeof window.yuantu), 'undefined');
    const browserState = await page.evaluate(() => window.yuantu.browser({ type: 'list' }));
    assert.equal(browserState.states[0].previewPath, 'report.html');
    assert.equal(
      browserState.states[0].url,
      'report.html',
      'the address contains the file path, not document source',
    );
    await writeFile(
      path.join(root, 'report.html'),
      '<title>Updated report</title><h1>Updated report</h1>',
    );
    await html.locator('.deliverable-open').click();
    await guest.waitForFunction(
      () => document.querySelector('h1')?.textContent === 'Updated report',
    );
    assert.equal(
      await page.locator('[data-browser-tab]').count(),
      1,
      'opening again refreshes the same browser tab',
    );
    await markdown.locator('.deliverable-open').click();
    await page.locator('#workspace-preview-body').waitFor({ state: 'visible' });
    assert.match(await page.locator('#workspace-preview-body').innerText(), /Current report/);
    assert.deepEqual(
      await app.evaluate(() => globalThis.__shellOpens),
      [],
      'deliverables never launch a system application',
    );
    await page.reload();
    await cards.nth(1).waitFor();
    assert.deepEqual(await cards.locator('.deliverable-title').allTextContents(), [
      'First report',
      'HTML report',
      'Revised report',
    ]);
    assert.equal(await page.locator('#deliverables-root').count(), 0);
  },
);
