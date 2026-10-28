import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { runtimeSnapshotMessage } from '../packages/core/context/runtime.ts';
import { frames, httpFixture, sendFrames, systemText } from './http-fixture.ts';
import { generateSessionTitle } from '../packages/core/session-title.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { storeFixture } from './temp-fixture.ts';

test('title output budget leaves room for reasoning before a short visible title', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    // This local endpoint emulates a compatible gateway, whose output cap uses max_tokens.
    const enough = body.max_tokens >= 512;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: '需要先分析，再给出简短标题。' },
            finish_reason: null,
          },
        ],
      },
      ...(enough
        ? [{ choices: [{ index: 0, delta: { content: '修复标题生成' }, finish_reason: null }] }]
        : []),
      {
        choices: [{ index: 0, delta: {}, finish_reason: enough ? 'stop' : 'length' }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: enough ? 100 : 64,
          completion_tokens_details: { reasoning_tokens: enough ? 90 : 64 },
        },
      },
    ];
    res.end(
      events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') +
        'data: [DONE]\n\n',
    );
  });
  const title = await generateSessionTitle(
    new OpenAIProvider({
      protocol: 'openai',
      baseUrl: url,
      apiKey: 'fixture',
      model: 'thinking-fixture',
    }),
    '当前项目的会话标题生成一直失败，请修复',
    new AbortController().signal,
  );
  assert.equal(title?.title, '修复标题生成');
});

test('a stalled title cannot hold the reply and a late title is announced after completion', async (t) => {
  let releaseTitle: (() => void) | undefined;
  const url = await httpFixture(t, (body, res) => {
    if (systemText(body.system).includes('为这段会话生成')) {
      releaseTitle = () => sendFrames(res, frames('修复登录跳转'));
    } else sendFrames(res, frames('Reply without waiting for a title.'));
  });
  const client = await titleHost(t, url);
  const session = await client.request('session.create', {});
  let announced!: () => void;
  const updated = new Promise<void>((resolve) => {
    announced = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'session.title.updated' && event.sessionId === session.id) announced();
  });
  const run = client.run(session.id, '修复登录跳转');
  try {
    const result = await Promise.race([run, delay(4000).then(() => null)]);
    assert.ok(result, 'the reply must finish while the title response is still withheld');
    assert.equal(result.status, 'completed', result.error);
    assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录跳转');
  } finally {
    releaseTitle?.();
  }
  assert.equal(await Promise.race([updated.then(() => true), delay(2000).then(() => false)]), true);
  assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录跳转');
});

test('Host shutdown aborts a title still running after the answer finished', async (t) => {
  let titleClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    titleClosed = resolve;
  });
  const url = await httpFixture(t, (body, res) => {
    if (systemText(body.system).includes('为这段会话生成')) {
      res.once('close', titleClosed);
    } else sendFrames(res, frames('Done.'));
  });
  const client = await titleHost(t, url);
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, '检查登录流程');
  assert.equal(result.status, 'completed', result.error);
  await client.stop();
  assert.equal(await Promise.race([closed.then(() => true), delay(2000).then(() => false)]), true);
});

async function titleHost(t: test.TestContext, url: string): Promise<AgentHostClient> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-title-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    requestTimeoutMs: 20_000,
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_MAX_RETRIES: '0',
      YUANTU_SESSION_TITLES: 'true',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await client.start();
  return client;
}

test('a machine-written first message does not name the session', async (t) => {
  const { root, store, session } = await storeFixture(t, 'yuantu-title-store-');
  /**
   * A runtime snapshot is a user-role message the runtime wrote to itself. It used to be what the session was
   * named after — the sidebar showed `<runtime-context source="memory"> Machine-written snapshot …` — because
   * the fallback title is "the first user message". The first *person's* message names it instead.
   */
  store.append(session.id, {
    role: 'user',
    content: runtimeSnapshotMessage('memory', 'release: staged rollout 481'),
  });
  assert.equal(store.get(session.id).title, '', 'bookkeeping does not name a session');
  assert.equal(store.canGenerateTitle(session.id), true, 'and the model may still name it');
  store.append(session.id, { role: 'user', content: '这个项目最后一次提交是什么功能' });
  assert.equal(store.get(session.id).title, '这个项目最后一次提交是什么功能');
  // A compaction summary is machine-written in the same sense, and is skipped the same way.
  const compacted = store.create(root);
  store.append(compacted.id, {
    role: 'user',
    content: '<compacted-summary>\n目标：…\n</compacted-summary>',
  });
  assert.equal(store.get(compacted.id).title, '');
  store.append(compacted.id, { role: 'user', content: '接着做' });
  assert.equal(store.get(compacted.id).title, '接着做');
});

test('generated title is saved once and a manual title always wins', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-title-store-');
  const generated = store.create(root);
  store.append(generated.id, { role: 'user', content: '原始问题' });
  assert.equal(store.canGenerateTitle(generated.id), true);
  assert.equal(store.setGeneratedTitle(generated.id, '  精简标题  '), true);
  assert.equal(store.get(generated.id).title, '精简标题');
  assert.equal(store.canGenerateTitle(generated.id), false);
  assert.equal(store.setGeneratedTitle(generated.id, '再次生成'), false);
  store.rename(generated.id, '用户命名');
  assert.equal(store.setGeneratedTitle(generated.id, '覆盖用户命名'), false);
  assert.equal(store.get(generated.id).title, '用户命名');

  const manual = store.create(root);
  store.rename(manual.id, '首轮前手动命名');
  assert.equal(store.canGenerateTitle(manual.id), false);
  assert.equal(store.setGeneratedTitle(manual.id, '自动命名'), false);
  assert.equal(store.get(manual.id).title, '首轮前手动命名');
});

test('migration protects names already stored in an older database', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-title-legacy-'));
  const file = path.join(root, 'sessions.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,active_run TEXT,title TEXT NOT NULL DEFAULT ''); PRAGMA user_version=20;",
  );
  old
    .prepare('INSERT INTO sessions(id,workspace,created_at,active_run,title) VALUES(?,?,?,NULL,?)')
    .run('old', root, new Date().toISOString(), '旧会话名称');
  old.close();
  const store = new SessionStore(file);
  try {
    assert.equal(store.get('old').title, '旧会话名称');
    assert.equal(store.canGenerateTitle('old'), false);
    assert.equal(store.setGeneratedTitle('old', '不应覆盖'), false);
  } finally {
    store.close();
  }
});

test('the configured model names the session once independently of its first reply', async (t) => {
  const requests: unknown[] = [];
  const url = await httpFixture(t, (body, res) => {
    requests.push(body);
    sendFrames(
      res,
      frames(
        systemText(body.system).includes('为这段会话生成')
          ? '标题：“修复登录跳转”。'
          : 'I fixed the login redirect.',
      ),
    );
  });
  const client = await titleHost(t, url);
  const session = await client.request('session.create', {});
  let titleUpdated!: () => void;
  const named = new Promise<void>((resolve) => {
    titleUpdated = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'session.title.updated' && event.sessionId === session.id) titleUpdated();
  });
  const first = await client.run(session.id, '登录后会跳回首页，请修复');
  assert.equal(first.status, 'completed', first.error);
  assert.equal(await Promise.race([named.then(() => true), delay(2000).then(() => false)]), true);
  assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录跳转');
  assert.equal(requests.length, 2);
  const titleRequest = requests.find((request) =>
    systemText((request as { system?: unknown }).system).includes('为这段会话生成'),
  ) as { tools?: unknown[]; messages?: { content?: string }[] };
  /**
   * The title call is tool-free, and the assertion says that rather than naming one provider's encoding of it.
   *
   * The two providers disagree on the wire shape of "no tools", and both are right: Anthropic and OpenAI Chat
   * omit the field entirely (an empty `tools` array is noise the endpoint has to parse), while the Responses
   * provider sends `[]`. What this test is about is that the naming call cannot act on the conversation, so it
   * asserts the capability — no tool definitions — not the encoding.
   */
  assert.deepEqual(titleRequest.tools ?? [], []);
  assert.match(JSON.stringify(titleRequest.messages), /登录后会跳回首页/);
  assert.doesNotMatch(JSON.stringify(titleRequest.messages), /助手答复/);
  const detail = await client.request('session.get', { sessionId: session.id });
  assert.ok(detail.statistics);
  assert.equal(detail.statistics.inputTokens, 40);
  assert.equal(detail.statistics.outputTokens, 20);
  await client.run(session.id, '再检查一下');
  assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录跳转');
  assert.equal(requests.length, 3);
});

test('manual rename prevents model title generation', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (_, res) => {
    requests++;
    sendFrames(res, frames('The login redirect is fixed.'));
  });
  const client = await titleHost(t, url);
  const session = await client.request('session.create', {});
  await client.request('session.rename', { sessionId: session.id, title: '我的登录任务' });
  const result = await client.run(session.id, '修复登录跳转');
  assert.equal(result.status, 'completed', result.error);
  assert.equal((await client.request('session.list', {}))[0]?.title, '我的登录任务');
  assert.equal(requests, 1);
});

test('failed naming keeps a fallback and retries the original topic on a later turn', async (t) => {
  let requests = 0;
  let titles = 0;
  const titlePrompts: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    requests++;
    if (systemText(body.system).includes('为这段会话生成')) {
      titles++;
      titlePrompts.push(JSON.stringify(body.messages));
      if (titles === 1) {
        res.writeHead(500);
        res.end();
      } else sendFrames(res, frames('修复登录问题'));
    } else sendFrames(res, frames('The login redirect is fixed.'));
  });
  const client = await titleHost(t, url);
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, '修复登录跳转');
  assert.equal(result.status, 'completed', result.error);
  assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录跳转');
  assert.equal(requests, 2);
  let titleUpdated!: () => void;
  const named = new Promise<void>((resolve) => {
    titleUpdated = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'session.title.updated' && event.sessionId === session.id) titleUpdated();
  });
  await client.run(session.id, '继续检查');
  assert.equal(await Promise.race([named.then(() => true), delay(2000).then(() => false)]), true);
  assert.equal((await client.request('session.list', {}))[0]?.title, '修复登录问题');
  assert.equal(requests, 4);
  assert.match(titlePrompts[1]!, /修复登录跳转/);
  assert.doesNotMatch(titlePrompts[1]!, /继续检查/);
});
