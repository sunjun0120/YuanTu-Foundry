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
import { mcpHttpFixture } from './mcp-http-fixture.ts';

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
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Automatic gateway');
    await page.locator('#settings-protocol').selectOption('anthropic');
    await page.locator('#settings-url').fill(endpoint);
    await page.locator('#settings-model').fill('auto-model');
    await page.locator('#settings-key').fill('synthetic-unused-secret');
    await page.locator('#settings-save').click();
    await page.getByText('模型配置已保存并生效，可以开始聊天。', { exact: true }).waitFor();
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
  'settings is a full page and chat switches saved models without losing session or draft',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-page-'));
    let release;
    const url = await httpFixture(t, async (_body, res) => {
      await new Promise((resolve) => (release = resolve));
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
    page.setDefaultTimeout(8000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#settings-page').isVisible(), true);
    assert.equal(await page.locator('#chat-page').isVisible(), false);
    assert.equal(await page.locator('#general-settings-content').isVisible(), true);
    assert.equal(await page.locator('#model-settings-content').isHidden(), true);
    // The command-isolation form is gone: the composer's chip is the only control that writes either knob.
    assert.equal(await page.locator('#sandbox-settings').count(), 0);
    assert.equal(await page.locator('#model option').last().textContent(), '模型设置');
    await page.locator('#ui-language').selectOption('en-US');
    assert.equal(await page.locator('#general-settings-title').textContent(), 'General');
    assert.equal(await page.locator('#model option').last().textContent(), 'Model settings');
    await page.locator('#ui-language').selectOption('zh-CN');
    await page.locator('#model-settings').click();
    assert.deepEqual(
      await page
        .locator('#settings-protocol option')
        .evaluateAll((options) => options.map((option) => option.value)),
      ['openai', 'anthropic', 'openai-responses'],
    );
    assert.equal(await page.locator('#settings-protocol').inputValue(), 'openai');
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
    const id = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.locator('#settings-back').click();
    await page.locator('#prompt').fill('保留这份草稿');
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-model').waitFor();
    const endpointLabels = await page.locator('#settings-connection option').allTextContents();
    assert.equal(new Set(endpointLabels).size, 2);
    assert.ok(endpointLabels.every((label) => !label.includes(url)));
    assert.match(
      await page.locator('#settings-connection option:checked').innerText(),
      /当前默认$/,
    );
    await page.locator('#settings-back').click();
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await page.locator('#ui-language').selectOption('en-US');
    await page.locator('#model-settings').click();
    assert.match(
      await page.locator('#settings-connection option:checked').innerText(),
      /Current default$/,
    );
    await page.locator('#general-settings').click();
    await page.locator('#ui-language').selectOption('zh-CN');
    await page.locator('#model-settings').click();
    if (process.env.YUANTU_QA_DIR)
      await page.screenshot({ path: path.join(process.env.YUANTU_QA_DIR, 'settings-page.png') });
    await page.locator('#settings-back').click();
    assert.equal(await page.locator('#prompt').inputValue(), '保留这份草稿');
    await page.locator('#model').selectOption(saved.a.settings.connectionId);
    await waitForPage(
      page,
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.model === 'model-a',
    );
    await page.waitForFunction(
      () =>
        !document.querySelector('#model').disabled &&
        document.querySelector('#model-switch-status').hidden,
    );
    assert.equal(await page.locator('#prompt').inputValue(), '保留这份草稿');
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      ),
      id,
    );
    if (process.env.YUANTU_QA_DIR)
      await page.screenshot({
        path: path.join(process.env.YUANTU_QA_DIR, 'chat-model-picker.png'),
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
      page.setDefaultTimeout(10000);
      await page.getByRole('button', { name: '设置', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      return page;
    };
    let page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Primary endpoint');
    await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
    assert.equal(
      await page.locator('#settings-context-tokens').getAttribute('placeholder'),
      '自动（可手动指定）',
    );
    assert.equal(
      await page.locator('#settings-output-tokens').getAttribute('placeholder'),
      '自动（可手动指定）',
    );
    await page.locator('#settings-context-tokens').fill('128000');
    await page.locator('#settings-output-tokens').fill('8192');
    await page.locator('#settings-protocol').selectOption('anthropic');
    await page.getByLabel('接口地址').fill(url);
    await page.getByLabel('模型 ID', { exact: true }).fill('configured-model');
    await page.getByLabel('API 密钥', { exact: true }).fill('settings-ui-secret');
    await page.locator('#settings-test').click();
    await page.getByText('连接成功，模型已返回响应。测试不会保存配置。', { exact: true }).waitFor();
    assert.equal(requests, 1);
    const before = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(before.settings.hasKey, false);
    const session = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.locator('#settings-save').click();
    await page.getByText('模型配置已保存并生效，可以开始聊天。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
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
    if (process.env.YUANTU_QA_SCREENSHOT)
      await page.screenshot({ path: process.env.YUANTU_QA_SCREENSHOT });
    await page.locator('#settings-back').click();
    await page.getByRole('textbox', { name: '任务描述' }).fill('配置后开始聊天');
    await page.locator('#send').click();
    await page.getByText('配置生效后的回复', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.getByLabel('模型 ID', { exact: true }).fill('changed-model');
    // Inject a genuine abnormal exit precisely when the old Host begins shutdown.
    await app.evaluate(() => {
      const hosts = process
        ._getActiveHandles()
        .filter((handle) =>
          handle.spawnargs?.some((arg) => /[\\/]apps[\\/]agent-host[\\/]main\.js$/.test(arg)),
        );
      if (hosts.length !== 1) throw new Error('Expected one active desktop Host');
      const host = hosts[0];
      const end = host.stdin.end.bind(host.stdin);
      host.stdin.end = (...args) => {
        host.kill('SIGKILL');
        return end(...args);
      };
    });
    await page.locator('#settings-save').click();
    await page
      .getByText('模型配置已保存并生效，但旧进程退出异常，请检查残留进程。', { exact: true })
      .waitFor();
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
    assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'changed-model');
    assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
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
      page.setDefaultTimeout(10000);
      await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      return page;
    };
    let page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-endpoint-name').fill('Responses endpoint');
    await page.locator('#settings-protocol').selectOption('openai-responses');
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
    assert.equal(await page.locator('#settings-protocol').inputValue(), 'openai-responses');
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
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
    await page.locator('#settings-protocol').selectOption('anthropic');
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
    assert.equal(await page.locator('.settings-model-details').first().isHidden(), true);
    assert.equal(await page.locator('.settings-model-row input[type="number"]').count(), 8);
    const selectedEndpoint = await page
      .locator('#settings-connection option:checked')
      .textContent();
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
    assert.ok(Math.abs(placement.protocolLabelCenter - placement.protocolSelectCenter) < 2);
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
    assert.equal(await page.locator('.settings-model-details').first().isVisible(), true);
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
      await page.locator('#ui-appearance').selectOption('dark');
      await page.locator('#model-settings').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.screenshot({ path: path.join(process.env.YUANTU_QA_DIR, 'catalog.png') });
      await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
      await page.screenshot({ path: path.join(process.env.YUANTU_QA_DIR, 'catalog-expanded.png') });
      await page.locator('.settings-model-row').first().locator('[data-action="expand"]').click();
      await page.locator('#model-settings-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: path.join(process.env.YUANTU_QA_DIR, 'catalog-top.png') });
    }
    await page.locator('#settings-back').click();
    await page.locator('#model').selectOption(saved.connections[1].connectionId);
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
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
    assert.equal(await page.locator('#model option:checked').textContent(), 'old-model');
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
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
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
    await mkdir(path.resolve('artifacts'), { recursive: true });
    await page.locator('#permission-trigger').click();
    await page.screenshot({ path: path.resolve('artifacts/permission-presets.png') });
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
    // One choice, two knobs: the shipped default is the middle rung, and nothing has been written anywhere.
    assert.equal((await pair(page)).view.current, 'guarded');
    assert.equal((await pair(page)).view.permission, 'ask');
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
    assert.equal(await page.locator('#full-access-enable').isDisabled(), true);
    assert.equal(
      (await pair(page)).view.current,
      'guarded',
      'nothing moved before the confirmation',
    );
    await page.locator('#full-access-cancel').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), false);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-acknowledge').check();
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
     * The menu is the three rungs and nothing else: no sentence under each option, and no environment line while
     * the backend behind the current rung is usable. That line appears only when a backend answered that it
     * cannot run — the one fact that changes what the choice will do.
     */
    await page.locator('#permission-trigger').click();
    assert.equal(await page.locator('#permission-environment').isVisible(), false);
    assert.deepEqual(
      await page
        .locator('#permission-menu [data-preset] .permission-copy')
        .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
      ['仅可查看', '工作区内修改', '完全权限'],
    );
    await page.keyboard.press('Escape');
    /**
     * A new session starts at the default — which is the whole of "每次新会话都会重置": the choice is kept per
     * session id, so there is nothing to clear when a fresh one arrives.
     */
    await page.evaluate(() => window.yuantu.invoke({ type: 'create' }));
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'guarded',
      undefined,
      { timeout: 15000 },
    );
    assert.equal((await pair(page)).view.current, 'guarded');
    const created = await sessionId();
    assert.notEqual(created, initial);
    // Going back to the session that chose full access gives it back: the choice follows the session.
    await page.evaluate((id) => window.yuantu.invoke({ type: 'load', id }), initial);
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'unconfined',
      undefined,
      { timeout: 15000 },
    );
    /**
     * The launch environment names where a new session *starts*, and nothing more.
     *
     * With `YUANTU_SANDBOX=host` the default pair is host + ask, which no preset declares — so the chip reports
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
    assert.equal((await pair(page)).view.sandbox.mode, 'sbx');
  },
);

// ---- merged from mcp-settings.smoke.mjs ----

test(
  'desktop MCP settings test drafts, persist servers and expose saved tools to chat',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-ui-'));
    let turn = 0;
    const modelUrl = await httpFixture(t, (_body, res) =>
      sendFrames(
        res,
        turn++ === 0
          ? frames('', [{ id: 'list-mcp', name: 'mcp_local_list_tools', input: {} }])
          : frames('MCP_CHAT_OK'),
      ),
    );
    const remoteUrl = await mcpHttpFixture(t, (body, res) => {
      if (body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { tools: [{ name: 'remote_echo', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    const env = {
      ...process.env,
      YUANTU_SANDBOX: 'host',
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: modelUrl,
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
      page.setDefaultTimeout(10000);
      await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      return page;
    };
    let page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#mcp-settings').click();
    await page.locator('#mcp-id').fill('local');
    await page.locator('#mcp-command').fill(process.execPath);
    await page.locator('#mcp-args').fill(path.resolve('tests/mcp-fixture.ts') + '\npid.txt');
    assert.equal(
      await page.locator('#mcp-env').getAttribute('placeholder'),
      '{' + '"API_TOKEN":"$' + '{MCP_TOKEN}"}',
    );
    await page.locator('#mcp-test').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('连接成功'),
    );
    await assert.rejects(readFile(path.join(root, '.yuantu/mcp.json')), { code: 'ENOENT' });
    const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
    assert.throws(() => process.kill(pid, 0));
    await page.locator('#mcp-save').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('已保存'),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.local
        .transport,
      'stdio',
    );
    await page.locator('#mcp-new').click();
    await page.locator('#mcp-id').fill('remote');
    await page.locator('#mcp-transport').selectOption('http');
    await page.locator('#mcp-url').fill(remoteUrl);
    await page.locator('#mcp-test').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('发现 1 个工具'),
    );
    await page.locator('#mcp-enabled').uncheck();
    await page.locator('#mcp-save').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('已保存'),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.remote
        .disabled,
      true,
    );
    // The OAuth block only exists for remote transports, and an invalid draft never reaches disk.
    assert.equal(await page.locator('#mcp-oauth').isVisible(), true);
    await page.locator('#mcp-oauth-enabled').check();
    assert.equal(await page.locator('#mcp-oauth-fields').isVisible(), true);
    assert.equal(await page.locator('#mcp-revoke').isDisabled(), true);
    assert.equal(await page.locator('#mcp-authorize').isDisabled(), true);
    await page.locator('#mcp-oauth-client-secret').fill('plaintext-secret');
    await page.locator('#mcp-save').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('环境变量占位符'),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.remote.oauth,
      undefined,
    );
    await page.locator('#mcp-oauth-redirect-port').fill('80');
    assert.equal(
      await page.locator('#mcp-oauth-redirect-port').evaluate((input) => input.checkValidity()),
      false,
    );
    await page.locator('#mcp-oauth-client-secret').fill('${MCP_CLIENT_SECRET}');
    await page.locator('#mcp-oauth-redirect-port').fill('53682');
    await page.locator('#mcp-oauth-scopes').fill('mcp.read, mcp.write');
    await page.locator('#mcp-oauth-client-id').fill('client-id');
    await page.locator('#mcp-oauth-client-name').fill('YuanTu Agent');
    await page.locator('#mcp-save').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('已保存'),
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.remote.oauth,
      {
        scopes: ['mcp.read', 'mcp.write'],
        clientId: 'client-id',
        clientName: 'YuanTu Agent',
        clientSecret: '${MCP_CLIENT_SECRET}',
        redirectPort: 53682,
      },
    );
    // Saving round-trips the OAuth fields, and the panel never persists authorization status.
    await page.locator('#mcp-transport').selectOption('stdio');
    assert.equal(await page.locator('#mcp-oauth').isVisible(), false);
    await page.locator('#mcp-transport').selectOption('http');
    assert.equal(await page.locator('#mcp-oauth-scopes').inputValue(), 'mcp.read, mcp.write');
    assert.equal(await page.locator('#mcp-oauth-redirect-port').inputValue(), '53682');
    assert.equal(await page.locator('#mcp-authorize').isDisabled(), true);
    await page.screenshot({ path: path.resolve('artifacts/mcp-settings-ui.png') });
    await page.locator('#model-settings').click();
    assert.equal(await page.locator('#settings-form').isVisible(), true);
    await page.locator('#settings-back').click();
    await page.locator('#prompt').fill('list MCP');
    await page.locator('#send').click();
    await page.getByRole('button', { name: '允许一次' }).click();
    await page.getByText('MCP_CHAT_OK', { exact: true }).waitFor();
    await app.close();
    page = await launch();
    await page.locator('#open-settings').click();
    await page.locator('#mcp-settings').click();
    await page.locator('#mcp-list').selectOption('remote');
    assert.equal(await page.locator('#mcp-enabled').isChecked(), false);
    assert.equal(await page.locator('#mcp-settings').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#model-settings').getAttribute('aria-current'), null);
    await page.locator('#mcp-headers').fill('{invalid unsaved');
    await page.locator('#mcp-delete').click();
    await page.locator('#mcp-delete-yes').click();
    await page.waitForFunction(() =>
      document.querySelector('#mcp-feedback').textContent.includes('已删除'),
    );
    const saved = JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8'));
    assert.ok(saved.servers.local);
    assert.equal(saved.servers.remote, undefined);
    const bad = await page.evaluate(() =>
      window.yuantu.mcp({ type: 'get', path: 'C:/not-allowed' }),
    );
    assert.equal(bad.ok, false);
    const oldView = await page.evaluate(() => window.yuantu.mcp({ type: 'get' }));
    const other = path.join(root, 'other-workspace');
    await mkdir(other);
    await page.locator('#settings-back').click();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, other);
    const switched = await page.evaluate(() => window.yuantu.invoke({ type: 'chooseWorkspace' }));
    assert.equal(switched.ok, true);
    await page.locator('#model').selectOption('__settings__');
    await page.waitForFunction(
      (target) => document.querySelector('#mcp-workspace').textContent.includes(target),
      other,
    );
    await page.waitForFunction(() => !document.querySelector('#mcp-save').disabled);
    assert.equal(await page.locator('#mcp-list option[value="local"]').count(), 0);
    const stale = await page.evaluate(
      ({ revision }) =>
        window.yuantu.mcp({
          type: 'save',
          revision,
          server: { id: 'stale', transport: 'http', url: 'https://example.com' },
        }),
      { revision: oldView.view.revision },
    );
    assert.equal(stale.ok, false);
    await assert.rejects(readFile(path.join(other, '.yuantu/mcp.json')), { code: 'ENOENT' });
  },
);
