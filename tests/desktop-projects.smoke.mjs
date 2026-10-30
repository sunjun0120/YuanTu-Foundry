// @test-serial desktop-ui: Real Electron workspace switching and background decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { artifactPath } from './desktop-smoke-support.mjs';
import { translate } from '../apps/desktop/i18n.ts';

test(
  'a background workspace receives its answer while another workspace remains visible',
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-project-routing-'));
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    let turns = 0;
    const url = await httpFixture(t, (body, response) => {
      if (turns++ === 0) {
        sendFrames(
          response,
          frames('需要确认 A 的主题', [
            {
              id: 'ask-a',
              name: 'ask_user_question',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: 'A 主题',
                    question: 'A 使用什么颜色？',
                    options: [{ label: '蓝色' }, { label: '红色' }],
                  },
                ],
              },
            },
          ]),
        );
      } else {
        assert.match(JSON.stringify(body.messages), /蓝色/);
        sendFrames(response, frames('A 已收到蓝色'));
      }
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: a,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    const processLog = [];
    app.process().stderr?.on('data', (chunk) => processLog.push(String(chunk)));
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled);
    const rejected = await page.evaluate(
      (folder) => window.yuantu.projects({ type: 'add', path: folder }),
      path.join(root, 'missing-workspace'),
    );
    assert.equal(
      rejected.ok,
      false,
      'invalid folders return a project error reply rather than rejecting IPC',
    );
    const added = await page.evaluate(
      (folder) => window.yuantu.projects({ type: 'add', path: folder }),
      b,
    );
    assert.equal(added.ok, true);
    const bId = added.registry.workspaces.find(
      (entry) => entry.canonicalPath.toLowerCase() === b.toLowerCase(),
    ).id;
    const aId = added.registry.workspaces.find((entry) => entry.id !== bId).id;
    const initialPreset = await page.evaluate(() => window.yuantu.presets({ type: 'get' }));
    await page.evaluate((id) => window.yuantu.projects({ type: 'select', id }), bId);
    const preset = await page.evaluate(() =>
      window.yuantu.presets({ type: 'set', preset: 'observe' }),
    );
    assert.equal(preset.ok, true, preset.error);
    await page.evaluate((id) => window.yuantu.projects({ type: 'select', id }), aId);
    const returnedPreset = await page.evaluate(() => window.yuantu.presets({ type: 'get' }));
    assert.equal(returnedPreset.view.current, initialPreset.view.current);
    await page.waitForFunction(
      (reading) => document.querySelector('#permission-mode')?.value === reading,
      initialPreset.view.current ?? 'custom',
    );
    const saved = await page.evaluate(
      (baseUrl) =>
        window.yuantu.settings({
          type: 'save',
          values: {
            connectionId: '',
            name: 'Shared fixture',
            protocol: 'anthropic',
            baseUrl,
            model: 'shared-fixture',
            apiKey: 'fixture',
            maxContextTokens: 128000,
          },
        }),
      url,
    );
    assert.equal(saved.ok, true, `${saved.error ?? ''}\n${processLog.join('')}`);
    assert.equal(saved.settings.connections.length, 1);
    const connection = saved.settings.connections[0];
    await page.evaluate((id) => window.yuantu.projects({ type: 'select', id }), bId);
    const applied = await page.evaluate(
      (connectionId) => window.yuantu.settings({ type: 'select', connectionId }),
      connection.connectionId,
    );
    assert.equal(applied.ok, true, applied.error);
    await page.evaluate((id) => window.yuantu.projects({ type: 'select', id }), aId);
    await page.locator('#prompt').fill('确认 A 的主题');
    await page.locator('#send').click();
    await page.locator('#questions .question-card').waitFor();
    const before = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    const selected = await page.evaluate(
      (id) => window.yuantu.projects({ type: 'select', id }),
      bId,
    );
    assert.equal(selected.ok, true, selected.error);
    await page.waitForFunction(
      (folder) =>
        document.querySelector('#workspace')?.textContent?.toLowerCase() === folder.toLowerCase(),
      b,
    );
    const snapshot = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.notEqual(snapshot.hostPid, before.hostPid);
    const denied = await page.evaluate((id) => window.yuantu.projects({ type: 'remove', id }), aId);
    assert.equal(denied.ok, false, 'a background workspace waiting for input cannot be removed');
    await page.locator('.project-waiting-summary').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '蓝色', exact: false }).click();
    await page.screenshot({ path: artifactPath('project-pending.png') });
    await dialog
      .getByRole('button', { name: translate('ui.questionSubmit', 'zh-CN'), exact: true })
      .click();
    await dialog.getByText(translate('projects.noPending', 'zh-CN')).waitFor();
    assert.equal(
      (
        await page.evaluate(async () => (await window.yuantu.invoke({ type: 'snapshot' })).state)
      ).workspace.toLowerCase(),
      b.toLowerCase(),
    );
    assert.doesNotMatch(await page.locator('#conversation').innerText(), /A 已收到蓝色/);
    const returned = await page.evaluate(
      (id) => window.yuantu.projects({ type: 'select', id }),
      aId,
    );
    assert.equal(returned.ok, true, returned.error);
    await dialog
      .getByRole('button', { name: translate('permission.dialog.close', 'zh-CN'), exact: true })
      .click();
    await page.getByText('A 已收到蓝色', { exact: true }).waitFor();
    const row = page.locator(`[data-project-id="${aId}"]`);
    await row.locator('.session-item').first().waitFor();
    const projectName = await row.locator('.project-name').boundingBox();
    const sessionList = await row.locator('.session-sidebar-root').boundingBox();
    assert.ok(
      sessionList.y >= projectName.y + projectName.height,
      'sessions must occupy a row below the workspace header',
    );
    await row.locator('.project-disclosure').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.project-row.selected .project-disclosure')
          ?.getAttribute('aria-expanded') === 'false',
    );
    assert.equal(await row.locator('.session-sidebar-root').isHidden(), true);
    await page.keyboard.press('Space');
    const group = page.locator('.project-group-toggle');
    await group.focus();
    await page.keyboard.press('Enter');
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector('.project-group-toggle')?.getAttribute('aria-expanded') === 'false',
    );
    await page.locator('.project-group-toggle').click();
    await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled);
    const cdp = await app.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    const target = await row.locator('.project-disclosure').boundingBox();
    assert.ok(target.width >= 36 && target.height >= 36);
    assert.equal(
      await row
        .locator('.project-actions')
        .evaluate((element) => getComputedStyle(element).opacity),
      '1',
    );
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    const goneA = await page.evaluate((id) => window.yuantu.projects({ type: 'remove', id }), aId);
    assert.equal(goneA.ok, true, goneA.error);
    const goneB = await page.evaluate((id) => window.yuantu.projects({ type: 'remove', id }), bId);
    assert.equal(goneB.ok, true, goneB.error);
    await page.locator('.project-empty').waitFor();
    assert.equal(await page.locator('.project-add-button').isEnabled(), true);
    await access(path.join(a, '.yuantu', 'sessions.sqlite'));
    await page.reload();
    await page.locator('.project-empty').waitFor();
    const empty = await page.evaluate(() => window.yuantu.projects({ type: 'list' }));
    assert.equal(empty.registry.activeWorkspaceId, null);
    const restored = await page.evaluate(
      (folder) => window.yuantu.projects({ type: 'add', path: folder }),
      a,
    );
    assert.equal(restored.addedId, aId);
    const reopened = await page.evaluate(
      (id) => window.yuantu.projects({ type: 'select', id }),
      aId,
    );
    assert.equal(reopened.ok, true, reopened.error);
    const replay = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.match(
      JSON.stringify(replay.session.messages),
      /A 已收到蓝色/,
      JSON.stringify({
        sessionId: replay.session.sessionId,
        sessions: replay.sessions.map((entry) => ({ id: entry.id, title: entry.title })),
        last: reopened.registry.workspaces.find((entry) => entry.id === aId)?.lastSessionId,
      }),
    );
    await page.getByText('A 已收到蓝色', { exact: true }).waitFor();
    await page.screenshot({ path: artifactPath('project-sidebar.png') });
  },
);
