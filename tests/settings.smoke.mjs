// @test-serial desktop-ui: Launches real Electron windows.
import { waitForPage } from './page-wait.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
process.env.YUANTU_SESSION_TITLES = 'false';
import { chooseSelectOption, readSelectOptions } from './desktop-smoke-support.mjs';
import { translate } from '../apps/desktop/i18n.ts';

test(
  'desktop saves blank model limits and completes chat with automatic capacity',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-auto-capacity-ui-'));
    let probes = 0;
    const endpoint = await httpFixture(t, (body, res, _headers, url) => {
      if (url === '/v1/models') {
        probes++;
        res.end(
          JSON.stringify({
            data: [{ id: 'auto-model', context_length: 96000, max_output_tokens: 4096 }],
          }),
        );
        return;
      }
      assert.equal(body.max_tokens, 4096);
      sendFrames(res, frames('Automatic desktop reply'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: '',
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      YUANTU_MAX_CONTEXT_TOKENS: '',
      YUANTU_MAX_OUTPUT_TOKENS: '',
      YUANTU_AUTO_COMPACT_TOKENS: '',
      YUANTU_MODEL_CAPACITIES: '',
      YUANTU_PROTOCOL: '',
      YUANTU_BASE_URL: '',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Automatic gateway');
    await chooseSelectOption(page, 'settings-protocol', 'Anthropic Messages');
    await page.locator('#settings-url').fill(endpoint);
    await page.locator('#settings-model').fill('auto-model');
    await page.locator('#settings-key').fill('synthetic-unused-secret');
    await page.locator('#settings-save').click();
    await page.getByText(translate('settingsMain.saved', 'zh-CN'), { exact: true }).waitFor();
    const saved = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(saved.settings.maxContextTokens, undefined);
    assert.equal(saved.settings.maxOutputTokens, undefined);
    await page.locator('#settings-back').click();
    await page.locator('#prompt').fill('Say hello');
    await page.locator('#send').click();
    await page.getByText('Automatic desktop reply', { exact: true }).waitFor();
    assert.equal(probes, 1);
  },
);

// ---- merged from settings-page.smoke.mjs ----

test(
  'settings opens in a card and chat switches saved models without losing session or draft',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-page-'));
    let release;
    let chats = 0;
    const url = await httpFixture(t, async (_body, res, _headers, requestPath) => {
      if (requestPath === '/v1/models') {
        res.end(
          JSON.stringify({
            data: ['model-a', 'model-b'].map((id) => ({
              id,
              context_length: 128000,
              max_output_tokens: 4096,
            })),
          }),
        );
        return;
      }
      if (++chats > 1) await new Promise((resolve) => (release = resolve));
      sendFrames(res, frames('done'));
    });
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_API_KEY: '',
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      release?.();
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
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(8000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    assert.equal(await page.locator('.settings-dialog[role="dialog"]').isVisible(), true);
    assert.equal(await page.locator('#chat-page').isVisible(), true);
    assert.equal(await page.locator('#chat-page').getAttribute('inert'), '');
    assert.equal(await page.locator('#general-settings-content').isVisible(), true);
    assert.equal(await page.locator('#model-settings-content').isHidden(), true);
    // The command-isolation form is gone: the composer's chip is the only control that writes either knob.
    assert.equal(await page.locator('#sandbox-settings').count(), 0);
    const modelActionLabel = async () => {
      await page.locator('#settings-back').click();
      const options = await readSelectOptions(page, 'model');
      await page.locator('#open-settings').click();
      return options.at(-1);
    };
    assert.equal(await modelActionLabel(), translate('settings.modelEntry', 'zh-CN'));
    await chooseSelectOption(page, 'ui-language', 'English');
    assert.equal(await page.locator('#general-settings-title').textContent(), 'General');
    assert.equal(await modelActionLabel(), translate('settings.modelEntry', 'en-US'));
    await chooseSelectOption(page, 'ui-language', 'Chinese');
    await page.locator('#model-settings').click();
    assert.deepEqual(await readSelectOptions(page, 'settings-protocol'), [
      'OpenAI Chat Completions',
      'Anthropic Messages',
      'OpenAI Responses',
    ]);
    assert.equal(
      await page.locator('#settings-protocol').inputValue(),
      translate('settings.protocolOpenai', 'en-US'),
    );
    assert.equal(await page.locator('#settings-url').inputValue(), 'https://api.openai.com');
    assert.equal(
      await page
        .locator('#settings-dialog,#evaluation-open,#open-logs,#startup-stage,#connection')
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => typeof window.yuantu.evaluation), 'undefined');
    const saved = await page.evaluate(async (url) => {
      const a = await window.yuantu.settings({
        type: 'save',
        values: {
          connectionId: '',
          name: '编码模型',
          model: 'model-a',
          apiKey: 'first-fixture-key',
          baseUrl: url,
          protocol: 'anthropic',
        },
      });
      const b = await window.yuantu.settings({
        type: 'save',
        values: {
          connectionId: '',
          name: '审阅模型',
          model: 'model-b',
          apiKey: 'second-fixture-key',
          baseUrl: url,
          protocol: 'anthropic',
        },
      });
      return { a, b };
    }, url);
    assert.equal(saved.a.ok, true);
    assert.equal(saved.b.ok, true);
    const beforeModelSelection = await page.evaluate(async () => {
      const state = (await window.yuantu.invoke({ type: 'snapshot' })).state;
      return {
        pid: state.hostPid,
        historyStart: state.session.historyStart,
        messages: state.session.messages,
      };
    });
    const id = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.locator('#settings-back').click();
    await page.locator('#prompt').fill('保留这份草稿');
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.waitForFunction(() => document.querySelector('#settings-model').value === 'model-b');
    const endpointLabels = await readSelectOptions(page, 'settings-connection');
    assert.equal(new Set(endpointLabels).size, 2);
    assert.ok(endpointLabels.every((label) => !label.includes(url)));
    await page.locator('#settings-connection').click();
    const optionGap = await page
      .getByRole('option')
      .first()
      .evaluate((option) => {
        const dropdown = option.closest('.mantine-Select-dropdown');
        const menu = dropdown.getBoundingClientRect();
        const row = option.getBoundingClientRect();
        // Keep the menu's intended padding, with equal space on both sides of each option.
        return Math.abs(menu.right - row.right - (row.left - menu.left));
      });
    assert.ok(
      optionGap <= 2,
      `saved-interface options must fill their dropdown (inset difference ${optionGap}px)`,
    );
    await page.keyboard.press('Escape');
    assert.match(await page.locator('#settings-connection').inputValue(), /当前默认$/);
    await page.locator('#settings-back').click();
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await chooseSelectOption(page, 'ui-language', 'English');
    await page.locator('#model-settings').click();
    assert.match(await page.locator('#settings-connection').inputValue(), /Current default$/);
    await page.locator('#general-settings').click();
    await chooseSelectOption(page, 'ui-language', 'Chinese');
    await page.locator('#model-settings').click();
    if (process.env.YUANTU_QA_DIR)
      await page.screenshot({ path: artifactPath('settings-page.png') });
    await page.locator('#settings-back').click();
    assert.equal(await page.locator('#prompt').inputValue(), '保留这份草稿');
    await chooseSelectOption(page, 'model', 'model-a');
    await waitForPage(
      page,
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.model === 'model-a',
    );
    await page.waitForFunction(
      () =>
        !document.querySelector('#model').disabled &&
        document.querySelector('#model-switch-status').hidden,
    );
    const picker = await page.locator('.model-picker-frame').evaluate((frame) => {
      const input = frame.querySelector('input');
      return {
        width: frame.getBoundingClientRect().width,
        textOverflow: getComputedStyle(input).textOverflow,
        paddingLeft: getComputedStyle(input).paddingLeft,
        paddingRight: getComputedStyle(input).paddingRight,
        title: input.getAttribute('title'),
      };
    });
    assert.ok(picker.width >= 72 && picker.width <= 360, `picker width ${picker.width}`);
    assert.equal(picker.textOverflow, 'ellipsis');
    assert.equal(picker.paddingLeft, '8px');
    assert.equal(picker.paddingRight, '28px');
    assert.equal(picker.title, 'model-a');
    assert.equal(await page.locator('#prompt').inputValue(), '保留这份草稿');
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      ),
      id,
    );
    const afterModelSelection = await page.evaluate(async () => {
      const state = (await window.yuantu.invoke({ type: 'snapshot' })).state;
      const settings = (await window.yuantu.settings({ type: 'get' })).settings;
      return {
        pid: state.hostPid,
        historyStart: state.session.historyStart,
        messages: state.session.messages,
        defaultConnectionId: settings.defaultConnectionId,
      };
    });
    assert.equal(
      afterModelSelection.pid,
      beforeModelSelection.pid,
      'model selection keeps the Host process',
    );
    assert.equal(afterModelSelection.historyStart, beforeModelSelection.historyStart);
    assert.deepEqual(afterModelSelection.messages, beforeModelSelection.messages);
    assert.equal(
      afterModelSelection.defaultConnectionId,
      saved.b.settings.defaultConnectionId,
      'a chat selection does not change the global default',
    );
    // An untouched session is already "new". Complete a turn so New task really
    // leaves this session and the default model can be checked in another one.
    await page.locator('#send').click();
    await page.getByText('done', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#send').dataset.mode === 'send');
    await page.locator('#new-session').click();
    await page.waitForFunction(() => document.querySelector('#model').value.includes('model-b'));
    await page.locator(`#sessions .session-item[data-session-id="${id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#model').value.includes('model-a'));
    assert.equal(await page.locator('#model-switch-status').isHidden(), true);
    await page.locator('#prompt').fill('保留这份草稿');
    if (process.env.YUANTU_QA_DIR)
      await page.screenshot({
        path: artifactPath('chat-model-picker.png'),
      });
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#send').dataset.mode === 'stop');
    assert.equal(await page.locator('#model').isDisabled(), true);
    const refused = await page.evaluate(
      (id) => window.yuantu.settings({ type: 'select', connectionId: id }),
      saved.b.settings.connectionId,
    );
    assert.equal(refused.ok, false);
    await page.locator('#send').click();
    release?.();
    await page.waitForFunction(() => document.querySelector('#send').dataset.mode === 'send');
  },
);

// ---- merged from model-settings.smoke.mjs ----

test(
  'desktop config tests, saves, applies, encrypts and restores credentials without environment',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-ui-'));
    let requests = 0;
    const url = await httpFixture(t, (body, res, headers) => {
      requests++;
      assert.equal(headers['x-api-key'], 'settings-ui-secret');
      assert.ok(['configured-model', 'changed-model'].includes(body.model));
      sendFrames(res, frames('配置生效后的回复'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: '',
      ANTHROPIC_BASE_URL: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    const launch = async () => {
      app = await electron.launch({
        executablePath: electronPath,
        args: [
          path.resolve('dist/desktop/main.cjs'),
          `--user-data-dir=${path.join(root, 'profile')}`,
        ],
        env,
      });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      page.setDefaultTimeout(10000);
      await page
        .getByRole('button', { name: translate('ui.settings', 'zh-CN'), exact: true })
        .waitFor();
      await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
      return page;
    };
    let page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Primary endpoint');
    await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
    assert.equal(
      await page.locator('#settings-context-tokens').getAttribute('placeholder'),
      translate('settings.automaticBudget', 'zh-CN'),
    );
    assert.equal(
      await page.locator('#settings-output-tokens').getAttribute('placeholder'),
      translate('settings.automaticBudget', 'zh-CN'),
    );
    await page.locator('#settings-context-tokens').fill('128000');
    await page.locator('#settings-output-tokens').fill('8192');
    await chooseSelectOption(page, 'settings-protocol', 'Anthropic Messages');
    await page.getByLabel(translate('settings.url', 'zh-CN')).fill(url);
    await page
      .getByLabel(translate('settings.modelId', 'zh-CN'), { exact: true })
      .fill('configured-model');
    await page
      .getByLabel(translate('settings.apiKey', 'zh-CN'), { exact: true })
      .fill('settings-ui-secret');
    await page.locator('#settings-test').click();
    await page
      .getByText(translate('settingsMain.testSucceeded', 'zh-CN'), { exact: true })
      .waitFor();
    assert.equal(requests, 1);
    const before = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(before.settings.hasKey, false);
    const session = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.locator('#settings-save').click();
    await page.getByText(translate('settingsMain.saved', 'zh-CN'), { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel(translate('settings.apiKey', 'zh-CN'), { exact: true }).inputValue(),
      '',
    );
    const publicSettings = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(publicSettings.settings.source, 'saved');
    assert.equal(publicSettings.settings.groupName, 'Primary endpoint');
    assert.equal(publicSettings.settings.maxContextTokens, 128000);
    assert.equal(publicSettings.settings.maxOutputTokens, 8192);
    assert.doesNotMatch(JSON.stringify(publicSettings), /settings-ui-secret/);
    const profile = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.doesNotMatch(
      await readFile(path.join(profile, 'model-settings.json'), 'utf8'),
      /settings-ui-secret/,
    );
    if (process.env.YUANTU_QA_SCREENSHOT) await page.screenshot({ path: artifactPath('qa.png') });
    await page.locator('#settings-back').click();
    await page
      .getByRole('textbox', { name: translate('ui.taskDescription', 'zh-CN') })
      .fill('配置后开始聊天');
    await page.locator('#send').click();
    await page.getByText('配置生效后的回复', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page
      .getByLabel(translate('settings.modelId', 'zh-CN'), { exact: true })
      .fill('changed-model');
    const pidBeforeSave = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.hostPid,
    );
    await page.locator('#settings-save').click();
    await page.locator('#settings-feedback').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#settings-feedback').getAttribute('data-error'), 'false');
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.hostPid,
      ),
      pidBeforeSave,
      'saving a model also keeps the Host process',
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.ready,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      ),
      session,
    );
    await app.close();
    app = undefined;
    page = await launch();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.getByText('配置生效后的回复', { exact: true }).waitFor();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    assert.equal(
      await page.getByLabel(translate('settings.modelId', 'zh-CN'), { exact: true }).inputValue(),
      'changed-model',
    );
    assert.equal(
      await page.getByLabel(translate('settings.apiKey', 'zh-CN'), { exact: true }).inputValue(),
      '',
    );
  },
);

test(
  'desktop selects, tests, saves and restores the Responses protocol',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-responses-ui-'));
    const url = await httpFixture(t, (body, res, headers, route) => {
      assert.equal(route, '/v1/responses');
      assert.equal(headers.authorization, 'Bearer responses-fixture');
      assert.equal(body.store, false);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'RESPONSES_OK', annotations: [] }],
                },
              ],
              usage: { input_tokens: 2, output_tokens: 2 },
            },
          }) +
          '\n\n',
      );
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_PERMISSION_POLICY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    const launch = async () => {
      app = await electron.launch({
        executablePath: electronPath,
        args: [
          path.resolve('dist/desktop/main.cjs'),
          '--user-data-dir=' + path.join(root, 'profile'),
        ],
        env,
      });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      page.setDefaultTimeout(10000);
      await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
      return page;
    };
    let page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Responses endpoint');
    await chooseSelectOption(page, 'settings-protocol', 'OpenAI Responses');
    await page.locator('#settings-url').fill(url);
    await page.locator('#settings-model').fill('fixture');
    await page.locator('#settings-key').fill('responses-fixture');
    // A saved connection declares its own context window — the environment is a fallback only while no connection
    // is saved — and a run with no declared window is refused before any request leaves (`declaredCapacity`). The
    // fixture has to fill the field the form requires, exactly as the model tests above do.
    await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
    await page.locator('#settings-context-tokens').fill('128000');
    await page.locator('#settings-test').click();
    await page.waitForFunction(() =>
      document.querySelector('#settings-feedback').textContent.includes('连接成功'),
    );
    await page.locator('#settings-save').click();
    await page.waitForFunction(() =>
      document.querySelector('#settings-feedback').textContent.includes('已保存'),
    );
    await app.close();
    page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    assert.equal(
      await page.locator('#settings-protocol').inputValue(),
      translate('settings.protocolResponses', 'en-US'),
    );
    const reply = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(reply.settings.protocol, 'openai-responses');
    assert.equal(reply.settings.hasKey, true);
    await page.locator('#settings-back').click();
    await page.locator('#prompt').fill('hello');
    await page.locator('#send').click();
    await page.getByText('RESPONSES_OK', { exact: true }).waitFor();
  },
);

// ---- merged from model-catalog.smoke.mjs ----

test(
  'desktop saves multiple models for one endpoint and switches them without losing the session',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-catalog-ui-'));
    let requests = 0;
    const endpoint = await httpFixture(t, (body, res, headers) => {
      requests++;
      assert.equal(headers['x-api-key'], 'shared-secret');
      assert.equal(body.model, 'text-model');
      sendFrames(res, frames('group-response'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: '',
      YUANTU_PROTOCOL: '',
      YUANTU_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    assert.equal(await page.locator('.workspace-resources').count(), 0);
    assert.equal(await page.locator('.composer-note').count(), 0);
    const session = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Primary gateway');
    assert.equal(
      await page
        .locator('.settings-model-row')
        .first()
        .locator('[data-action="expand"]')
        .getAttribute('aria-expanded'),
      'false',
    );
    await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
    await chooseSelectOption(page, 'settings-protocol', 'Anthropic Messages');
    await page.locator('#settings-url').fill(endpoint);
    await page.locator('#settings-key').fill('shared-secret');
    await page.locator('#settings-model').fill('vision-model');
    await page.locator('#settings-context-tokens').fill('256000');
    await page.locator('#settings-output-tokens').fill('32000');
    await page.locator('#settings-add-model').click();
    const secondRow = page.locator('.settings-model-row').nth(1);
    assert.equal(
      await secondRow.locator('[data-action="expand"]').getAttribute('aria-expanded'),
      'false',
    );
    await secondRow.locator('[data-action="expand"]').click();
    await secondRow.locator('[data-field="model"]').fill('text-model');
    await secondRow.locator('[data-field="maxContextTokens"]').fill('128000');
    await secondRow.locator('[data-field="maxOutputTokens"]').fill('16000');
    assert.equal(await page.locator('.settings-model-row [data-field="name"]').count(), 0);
    assert.equal(
      await page.locator('.settings-model-row [data-field="supportsVision"]').count(),
      0,
    );
    await page.locator('#settings-save').click();
    await page.locator('#settings-feedback').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('#settings-feedback').getAttribute('data-error'),
      'false',
      await page.locator('#settings-feedback').textContent(),
    );
    await waitForPage(
      page,
      async () => (await window.yuantu.settings({ type: 'get' })).settings.connections.length === 2,
    );
    const saved = await page.evaluate(
      async () => (await window.yuantu.settings({ type: 'get' })).settings,
    );
    assert.equal(saved.connections.length, 2);
    assert.equal(saved.groupName, 'Primary gateway');
    assert.equal(saved.connections[1].groupName, 'Primary gateway');
    assert.equal(saved.connections[0].groupId, saved.connections[1].groupId);
    assert.equal(saved.connections[0].baseUrl, saved.connections[1].baseUrl);
    assert.equal(saved.connections[0].maxContextTokens, 256000);
    assert.equal(saved.connections[1].maxContextTokens, 128000);
    assert.equal(saved.connections[1].supportsVision, true);
    assert.equal(saved.connections[1].name, 'text-model');
    assert.doesNotMatch(JSON.stringify(saved), /shared-secret/);
    assert.equal(await page.locator('#settings-key').inputValue(), '');
    assert.equal(await page.locator('.settings-model-row').count(), 2);
    // The row collapse is animated (180ms); the legacy form rebuilt its rows already hidden, so wait for the
    // animation the React form owns rather than sampling mid-flight.
    await page.locator('.settings-model-details').first().waitFor({ state: 'hidden' });
    // Two rows, each with a model id and four limit fields.
    assert.equal(await page.locator('.settings-model-row [data-field]').count(), 10);
    const selectedEndpoint = await page.locator('#settings-connection').inputValue();
    assert.ok(selectedEndpoint.startsWith('Primary gateway'));
    assert.ok(!selectedEndpoint.includes(endpoint));
    const placement = await page.evaluate(() => ({
      nameBottom: document.querySelector('#settings-endpoint-name').getBoundingClientRect().bottom,
      urlTop: document.querySelector('#settings-url').getBoundingClientRect().top,
      urlBottom: document.querySelector('#settings-url').getBoundingClientRect().bottom,
      protocolTop: document.querySelector('.settings-protocol').getBoundingClientRect().top,
      protocolLabelCenter: (() => {
        const rect = document.querySelector('#settings-protocol-label').getBoundingClientRect();
        return rect.top + rect.height / 2;
      })(),
      protocolSelectCenter: (() => {
        const rect = document.querySelector('#settings-protocol').getBoundingClientRect();
        return rect.top + rect.height / 2;
      })(),
      keyBottom: document.querySelector('#settings-key').getBoundingClientRect().bottom,
      modelsTop: document.querySelector('#settings-model-list').getBoundingClientRect().top,
      pickerWidth: document.querySelector('#settings-connection').getBoundingClientRect().width,
    }));
    assert.ok(placement.nameBottom < placement.urlTop);
    assert.ok(placement.urlBottom < placement.protocolTop);
    assert.ok(placement.protocolLabelCenter < placement.protocolSelectCenter);
    assert.ok(placement.urlBottom < placement.modelsTop);
    assert.ok(placement.keyBottom < placement.modelsTop);
    assert.ok(placement.pickerWidth > 200);
    await page.locator('#settings-model').fill('unsaved-draft');
    await page.locator('#settings-cancel').click();
    assert.equal(await page.locator('#settings-model').inputValue(), 'vision-model');
    const arrowCenters = await page
      .locator('.settings-model-row')
      .first()
      .locator('[data-action="expand"]')
      .evaluate((button) => {
        const outer = button.getBoundingClientRect();
        const inner = button.querySelector('.model-chevron').getBoundingClientRect();
        return [
          Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2),
          Math.abs(outer.y + outer.height / 2 - inner.y - inner.height / 2),
        ];
      });
    assert.ok(arrowCenters.every((distance) => distance < 1));
    const toggle = page.locator('.settings-model-row').first().locator('[data-action="expand"]');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    // The row opens with the shared 180ms Collapse, so wait for the animation's final state.
    await page.locator('.settings-model-details').first().waitFor({ state: 'visible' });
    const expandedCenters = await toggle.evaluate((button) => {
      const outer = button.getBoundingClientRect();
      const inner = button.querySelector('.model-chevron').getBoundingClientRect();
      return [
        Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2),
        Math.abs(outer.y + outer.height / 2 - inner.y - inner.height / 2),
      ];
    });
    assert.ok(expandedCenters.every((distance) => distance < 1));
    await toggle.click();
    if (process.env.YUANTU_QA_DIR) {
      await page.locator('#general-settings').click();
      await chooseSelectOption(page, 'ui-appearance', translate('general.appearanceDark', 'zh-CN'));
      await page.locator('#model-settings').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.screenshot({ path: artifactPath('catalog.png') });
      await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
      await page.screenshot({ path: artifactPath('catalog-expanded.png') });
      await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
      await page.locator('#model-settings-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: artifactPath('catalog-top.png') });
    }
    await page.locator('#settings-back').click();
    await chooseSelectOption(page, 'model', 'text-model');
    await waitForPage(
      page,
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.model === 'text-model',
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      ),
      session,
    );
    await page.locator('#prompt').fill('hello');
    await page.locator('#send').click();
    await page.getByText('group-response', { exact: true }).waitFor();
    assert.equal(requests, 1);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('.settings-model-row').first().locator('[data-action="remove"]').click();
    await page.locator('#settings-save').click();
    await page.locator('#settings-feedback').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('#settings-feedback').getAttribute('data-error'),
      'false',
      await page.locator('#settings-feedback').textContent(),
    );
    await waitForPage(
      page,
      async () => (await window.yuantu.settings({ type: 'get' })).settings.connections.length === 1,
    );
    const final = await page.evaluate(
      async () => (await window.yuantu.settings({ type: 'get' })).settings,
    );
    assert.equal(final.model, 'text-model');
    assert.equal(final.groupName, 'Primary gateway');
    assert.equal(final.connections.length, 1);
  },
);

test(
  'editing a legacy model keeps its hidden image capability and uses its model ID',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-catalog-legacy-'));
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    const seeded = await page.evaluate(() =>
      window.yuantu.settings({
        type: 'save-group',
        values: {
          groupId: '',
          name: 'Legacy endpoint',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:43123',
          apiKey: 'legacy-secret',
          models: [
            {
              model: 'old-model',
              name: 'Old alias',
              supportsVision: false,
              maxContextTokens: 128000,
              autoCompactTokens: 100000,
              maxOutputTokens: 8192,
              streamIdleTimeoutMs: 180000,
            },
          ],
        },
      }),
    );
    assert.equal(seeded.ok, true, seeded.error);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    assert.equal(await page.locator('[data-field="name"]').count(), 0);
    assert.equal(await page.locator('[data-field="supportsVision"]').count(), 0);
    await page.locator('#settings-save').click();
    await page.locator('#settings-feedback').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#settings-feedback').getAttribute('data-error'), 'false');
    const saved = await page.evaluate(
      async () => (await window.yuantu.settings({ type: 'get' })).settings,
    );
    assert.equal(saved.connections[0].supportsVision, false);
    assert.equal(saved.connections[0].autoCompactTokens, 100000);
    assert.equal(saved.connections[0].streamIdleTimeoutMs, 180000);
    assert.equal(saved.connections[0].name, 'old-model');
    assert.equal(await page.locator('#model').inputValue(), 'old-model');
    await page.locator('[data-action="expand"]').click();
    await page.locator('[data-field="autoCompactTokens"]').fill('90000');
    await page.locator('[data-field="streamIdleTimeoutMs"]').fill('60000');
    await page.locator('#settings-save').click();
    await waitForPage(
      page,
      async () =>
        (await window.yuantu.settings({ type: 'get' })).settings.autoCompactTokens === 90000,
    );
    await page.locator('[data-action="expand"]').click();
    for (const field of [
      'maxContextTokens',
      'autoCompactTokens',
      'maxOutputTokens',
      'streamIdleTimeoutMs',
    ])
      await page.locator(`[data-field="${field}"]`).fill('');
    await page.locator('#settings-save').click();
    await waitForPage(page, async () => {
      const settings = (await window.yuantu.settings({ type: 'get' })).settings;
      return [
        'maxContextTokens',
        'autoCompactTokens',
        'maxOutputTokens',
        'streamIdleTimeoutMs',
      ].every((field) => settings[field] === undefined);
    });
  },
);

// ---- merged from sandbox-settings.smoke.mjs ----

test(
  'the permission chip moves both security knobs as one preset, and the isolation form is gone',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-preset-ui-'));
    const profile = path.join(root, 'profile');
    const endpoint = await httpFixture(t, (_body, res) => {
      sendFrames(res, frames('Permission session started'));
    });
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: endpoint,
      YUANTU_PROTOCOL: 'anthropic',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.YUANTU_SANDBOX;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    const launch = async (extra = {}) => {
      app = await electron.launch({
        executablePath: electronPath,
        args: [path.resolve('dist/desktop/main.cjs'), `--user-data-dir=${profile}`],
        env: { ...env, ...extra },
      });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      page.setDefaultTimeout(10000);
      // The chip is enabled by this process, so it can be clicked before the Host can accept the change; every
      // step below assumes the pair can actually move.
      await waitForPage(
        page,
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.ready,
      );
      return page;
    };
    const pair = (page) => page.evaluate(() => window.yuantu.presets({ type: 'get' }));
    const sandboxMode = async () => {
      try {
        return JSON.parse(await readFile(path.join(profile, 'sandbox-settings.json'), 'utf8')).mode;
      } catch {
        return undefined;
      }
    };
    let page = await launch();
    await mkdir(path.resolve(artifactPath('')), { recursive: true });
    await page.locator('#permission-trigger').click();
    await page.screenshot({ path: path.resolve(artifactPath('permission-presets.png')) });
    await page.keyboard.press('Escape');
    /**
     * The form the settings page used to carry is gone, heading and all: the chip is the only control that
     * writes either knob, which is what keeps a pair no preset declares out of reach.
     */
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#sandbox-settings').count(), 0, 'the isolation form is gone');
    assert.equal(
      await page.locator('#general-settings-content').getByText('命令隔离').count(),
      0,
      'and so is its heading',
    );
    await page.locator('#settings-back').click();
    // One choice, two knobs: the shipped default is 帮我批准, and nothing has been written anywhere.
    assert.equal((await pair(page)).view.current, 'auto');
    assert.equal((await pair(page)).view.permission, 'auto');
    /**
     * The session has to exist before anything can be said about it: a fresh window answers with an empty id
     * until the carrier has started its first session.
     */
    const sessionId = () =>
      page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      );
    let initial = await sessionId();
    for (let attempt = 0; attempt < 50 && !initial; attempt += 1) {
      await page.waitForTimeout(100);
      initial = await sessionId();
    }
    assert.ok(initial, 'the carrier starts the session this choice belongs to');
    // Full access is the rung that gives up isolation, so it is asked about — and nothing moves until it is.
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), true);
    assert.equal((await pair(page)).view.current, 'auto', 'nothing moved before the confirmation');
    await page.locator('#full-access-cancel').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), false);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-enable').click();
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'unconfined',
    );
    // Both halves moved, and the pair is what the chip reads back.
    const applied = await pair(page);
    assert.equal(applied.view.current, 'unconfined');
    assert.equal(applied.view.sandbox.mode, 'host');
    assert.equal(applied.view.permission, 'full-access');
    /**
     * The sandbox half is a *live* switch, and the session is the proof: the old implementation moved it by
     * stopping the carrier and starting another one around the same session, which this asserts no longer
     * happens — same id, same window, no reload.
     */
    assert.equal(await sessionId(), initial, 'switching the sandbox does not restart anything');
    assert.equal(
      await page.evaluate(
        async () =>
          (await window.yuantu.invoke({ type: 'snapshot' })).state.session.messages.length,
      ),
      0,
      'and it does not disturb the conversation it was made in',
    );
    /**
     * The menu is the three current rungs, each with its one-line summary, and never a line about whether the backend
     * can run: a sandbox that needs setting up is offered above the composer instead. Read-only sessions remain
     * readable but the rung is no longer offered.
     */
    await page.locator('#permission-trigger').click();
    assert.equal(
      await page.locator('#permission-menu .permission-environment p:visible').count(),
      0,
    );
    assert.deepEqual(
      await page
        .locator('#permission-menu [data-preset] .permission-copy > span')
        .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
      [
        translate('permission.label.guarded', 'zh-CN'),
        translate('permission.label.auto', 'zh-CN'),
        translate('permission.label.unconfined', 'zh-CN'),
      ],
    );
    await page.keyboard.press('Escape');
    /**
     * A new session starts at the default, 帮我批准 — the choice is kept per session id, so there is nothing to
     * clear when a fresh one arrives, and full access never carries over into a conversation that did not ask.
     */
    // Security choices alone do not start a session; finish a real turn before
    // asking New task to create a different session with the default preset.
    await page.locator('#prompt').fill('Start this permission session');
    await page.locator('#send').click();
    await page.getByText('Permission session started', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#send').dataset.mode === 'send');
    await page.locator('#new-session').click();
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'auto',
      undefined,
      { timeout: 15000 },
    );
    assert.equal((await pair(page)).view.current, 'auto');
    const created = await sessionId();
    assert.notEqual(created, initial);
    // Going back to the session that chose full access gives it back: the choice follows the session.
    await page.locator(`#sessions .session-item[data-session-id="${initial}"]`).click();
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'unconfined',
      undefined,
      { timeout: 15000 },
    );
    /**
     * The launch environment names where a new session *starts*, and nothing more.
     *
     * With `YUANTU_SANDBOX=host` the default pair is host + auto, which no preset declares — so the chip reports
     * custom — and the rungs are still selectable, which is the difference between a deployment stating a
     * starting point and a deployment forbidding the alternatives.
     */
    await app.close();
    page = await launch({ YUANTU_SANDBOX: 'host' });
    assert.equal((await pair(page)).view.current, null);
    await page.locator('#permission-trigger').click();
    assert.equal(await page.locator('#permission-custom').isVisible(), true);
    assert.equal(
      await page.locator('#permission-menu [data-preset="guarded"]').isDisabled(),
      false,
    );
    await page.locator('#permission-menu [data-preset="guarded"]').click();
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'guarded',
    );
    assert.equal((await pair(page)).view.sandbox.mode, 'native');
  },
);

function artifactPath(relative) {
  return path.join(
    process.env.FOUNDRY_TEST_ARTIFACTS ||
      path.join(tmpdir(), 'yuantu-smoke-artifacts-' + process.pid),
    relative,
  );
}

test(
  'desktop lists an invalid startup environment in the banner and general settings',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invalid-env-ui-'));
    const misspelled = 'YUANTU_MAX_RETRIES'.replace(/S$/, '');
    const invalid = 'private-invalid-setting-value';
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'synthetic-key',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_MAX_RETRIES: invalid,
      [misspelled]: '2',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15000);
    await page.locator('#error-text').waitFor({ state: 'visible' });
    const banner = await page.locator('#error-text').textContent();
    assert.match(banner, new RegExp(misspelled));
    assert.match(banner, /did you mean YUANTU_MAX_RETRIES/);
    assert.doesNotMatch(banner, new RegExp(invalid));
    assert.doesNotMatch(banner, /Host.*意外退出|restart the application/);
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await page.locator('#general-environment').waitFor({ state: 'visible' });
    const problems = await page.locator('#general-environment-problems').textContent();
    assert.match(problems, new RegExp(misspelled));
    assert.match(problems, /did you mean YUANTU_MAX_RETRIES/);
    assert.doesNotMatch(problems, new RegExp(invalid));
  },
);
