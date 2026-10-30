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
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace')?.disabled);
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    const cards = page.locator('#messages > .deliverables-panel');
    await cards.nth(1).waitFor();
    assert.equal(await cards.count(), 2);
    assert.deepEqual(await cards.locator('.deliverable-description').allTextContents(), [
      'First report',
      'Revised report',
    ]);
    assert.deepEqual(await cards.locator('h2').allTextContents(), [
      translate('ui.turnDeliverablesTitle', 'zh-CN'),
      translate('ui.turnDeliverablesTitle', 'zh-CN'),
    ]);
    assert.equal(await cards.locator('.deliverable-action').count(), 4);
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
    await cards.first().locator('.deliverable-open').click();
    await page.waitForFunction(() =>
      document.querySelector('#workspace-preview-body')?.textContent.includes('Current report'),
    );
    await page.reload();
    await cards.nth(1).waitFor();
    assert.deepEqual(await cards.locator('.deliverable-description').allTextContents(), [
      'First report',
      'Revised report',
    ]);
    assert.equal(await page.locator('#deliverables-root').count(), 0);
  },
);
