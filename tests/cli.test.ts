import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ENVIRONMENT } from '../packages/protocol/settings.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { runCli } from './process-fixture.ts';

test('CLI completes read/edit/test cycle through HTTP and can reopen its session without credentials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'value.txt'), 'bad');
  await writeFile(
    path.join(root, 'verify.cjs'),
    'const fs=require("fs");if(fs.readFileSync("value.txt","utf8")!=="good")process.exit(1);console.log("verification passed")',
  );
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    const all = JSON.stringify(body.messages);
    if (step === 0)
      sendFrames(
        res,
        frames('Reading', [{ id: 'read', name: 'read_file', input: { path: 'value.txt' } }]),
      );
    else if (step === 1) {
      assert.match(all, /1: bad/);
      sendFrames(
        res,
        frames('Editing', [
          {
            id: 'edit',
            name: 'edit_file',
            input: { path: 'value.txt', old_text: 'bad', new_text: 'good' },
          },
        ]),
      );
    } else if (step === 2)
      sendFrames(
        res,
        frames('Testing', [
          { id: 'test', name: 'run_command', input: { command: 'node verify.cjs' } },
        ]),
      );
    else {
      assert.match(all, /verification passed/);
      sendFrames(res, frames('Changed value and verification passed.'));
    }
    step++;
  });
  const db = path.join(root, '.yuantu', 'sessions.sqlite');
  const env = {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
  };
  const result = await runCli(
    [
      'run',
      'Fix the value and verify',
      '--workspace',
      root,
      '--allow-write',
      '--allow-command',
      '--json',
    ],
    env,
  );
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(step, 4);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'good');
  const final = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  assert.equal(final.type, 'result');
  assert.equal(final.result.status, 'completed');
  const listing = await runCli(['sessions', '--db', db, '--json']);
  assert.equal(listing.code, 0, listing.stderr);
  assert.equal(JSON.parse(listing.stdout)[0].id, final.result.sessionId);
  const show = await runCli(['show', final.result.sessionId, '--db', db, '--json']);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /verification passed/);
  assert.doesNotMatch(show.stdout, /fixture-secret/);
  const resumed = await runCli(
    ['resume', final.result.sessionId, 'Summarize', '--db', db, '--json'],
    env,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const store = new SessionStore(db);
  assert.equal(store.messages(final.result.sessionId).filter((m) => m.role === 'user').length, 2);
  store.close();
});
test('CLI creates and inspects durable task specifications without model credentials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  store.close();
  const spec = path.join(root, 'task.json');
  await writeFile(
    spec,
    JSON.stringify({
      title: 'verify output',
      acceptance: [
        {
          description: 'output contains done',
          met: false,
          check: { id: 'output', kind: 'file-contains', path: 'output.txt', expected: 'done' },
        },
      ],
    }),
  );
  const created = await runCli(['task-create', session.id, spec, '--db', db, '--json']);
  assert.equal(created.code, 0, created.stderr);
  const task = JSON.parse(created.stdout);
  const listed = await runCli(['tasks', session.id, '--db', db, '--json']);
  assert.equal(JSON.parse(listed.stdout)[0].id, task.id);
  const shown = await runCli(['task', session.id, task.id, '--db', db, '--json']);
  assert.equal(JSON.parse(shown.stdout).acceptance[0].check.kind, 'file-contains');
  const failed = await runCli(['task-verify', session.id, task.id, '--db', db, '--json']);
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).attempt.verification.passed, false);
  await writeFile(path.join(root, 'output.txt'), 'done');
  const passed = await runCli(['task-verify', session.id, task.id, '--db', db, '--json']);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).task.status, 'completed');
  const attempts = await runCli(['task-attempts', session.id, task.id, '--db', db, '--json']);
  assert.deepEqual(
    JSON.parse(attempts.stdout).map((attempt: { kind: string; status: string }) => [
      attempt.kind,
      attempt.status,
    ]),
    [
      ['verify', 'needs_review'],
      ['verify', 'completed'],
    ],
  );
});

test('CLI reviews a persisted task approval without model credentials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-review-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Scheduled review',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const approvalId = store.deferTaskApproval(session.id, task.id, {
    kind: 'write',
    description: 'write_file: approved.txt',
    toolCall: {
      id: 'write',
      name: 'write_file',
      arguments: { path: 'approved.txt', content: 'ok' },
    },
  }).pendingApproval!.id;
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  store.close();

  const reviewed = await runCli([
    'task-approval',
    session.id,
    task.id,
    approvalId,
    'allow',
    '--db',
    db,
    '--json',
  ]);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).pendingApproval.state, 'approved');
  const second = await runCli([
    'task-approval',
    session.id,
    task.id,
    approvalId,
    'allow',
    '--db',
    db,
    '--json',
  ]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /no longer pending/);
});

test('CLI help needs no API key and invalid commands fail clearly', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /YUANTU_MODEL/);
  assert.match(help.stdout, /mcp authorize/);
  const invalid = await runCli(['run', 'test', '--unknown']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Unknown option/);
});
test('CLI lists MCP servers and their authorization state without model credentials', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-mcp-'));
  const credentials = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-mcp-cred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(credentials, { recursive: true, force: true }));
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(
    path.join(root, '.yuantu/mcp.json'),
    JSON.stringify({
      servers: {
        local: { transport: 'stdio', command: process.execPath, args: ['server.js'] },
        remote: {
          transport: 'http',
          url: 'https://example.com/mcp',
          oauth: { scopes: ['mcp.read'] },
        },
      },
    }),
  );
  const env = { YUANTU_MCP_OAUTH_DIR: credentials };
  const listed = await runCli(['mcp', 'list', '--workspace', root, '--json'], env);
  assert.equal(listed.code, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout.trim());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'local');
  assert.equal(rows[0].oauth, undefined);
  assert.equal(rows[1].oauth.authorized, false);
  assert.deepEqual(rows[1].oauth.scopes, ['mcp.read']);
  const unknown = await runCli(['mcp', 'authorize', 'missing', '--workspace', root], env);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown MCP server/);
  const plain = await runCli(['mcp', 'revoke', 'local', '--workspace', root], env);
  assert.equal(plain.code, 0, plain.stderr);
});
test('noninteractive CLI denies writes unless explicitly allowed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-denial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    if (step++ === 0)
      sendFrames(
        res,
        frames('', [
          { id: 'w', name: 'write_file', input: { path: 'denied.txt', content: 'bad' } },
        ]),
      );
    else {
      assert.match(JSON.stringify(body.messages), /Permission denied/);
      sendFrames(res, frames('Write was denied.'));
    }
  });
  const result = await runCli(['run', 'write', '--workspace', root, '--json'], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_API_KEY: 'test',
  });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(path.join(root, 'denied.txt')), { code: 'ENOENT' });
});

for (const effect of ['deny', 'ask'])
  test('CLI permission ' + effect + ' overrides allow-command and blocks effects', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-policy-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, 'effect.cjs'),
      'require("fs").writeFileSync("effect.txt","executed");',
    );
    const policy = path.join(root, 'policy.json');
    await writeFile(policy, JSON.stringify({ version: 1, rules: [{ effect, kind: 'command' }] }));
    let step = 0;
    const url = await httpFixture(t, (_body, res) =>
      sendFrames(
        res,
        step++ === 0
          ? frames('', [
              { id: 'command', name: 'run_command', input: { command: 'node effect.cjs' } },
            ])
          : frames('Stopped.'),
      ),
    );
    const result = await runCli(
      [
        'run',
        'try command',
        '--workspace',
        root,
        '--json',
        '--allow-command',
        '--permission-policy',
        policy,
      ],
      {
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
        YUANTU_API_KEY: 'fixture',
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Permission denied/);
    await assert.rejects(readFile(path.join(root, 'effect.txt')), { code: 'ENOENT' });
  });

test('a CLI invocation converges child runs an earlier crashed invocation left running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-child-runs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.yuantu', 'sessions.sqlite');
  const store = new SessionStore(file);
  const parent = store.create(root);
  // A real delegated child: parent recorded, no fork count.
  const child = store.create(root, parent.id);
  const stale = new DatabaseSync(file);
  const now = new Date().toISOString();
  // The Host died mid-delegation: the child's run is still `running` and owned by a dead process.
  stale
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
    )
    .run('child-crashed', child.id, 2147483647, now);
  stale.prepare('UPDATE sessions SET active_run=? WHERE id=?').run('child-crashed', child.id);
  // The parent's own stale run is converged by the same startup pass, in `reconcileInterruptedRuns`: an
  // ordinary session is one a user can open, delete or rename, and a stale `active_run` is exactly what made
  // those three refuse. What that pointer used to signal now lives in the parent's log as `run.interrupted`.
  stale
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
    )
    .run('parent-crashed', parent.id, 2147483647, now);
  stale.prepare('UPDATE sessions SET active_run=? WHERE id=?').run('parent-crashed', parent.id);
  stale.close();
  store.close();

  // `sessions` needs no model, so this exercises the startup path itself.
  const result = await runCli(['sessions', '--workspace', root, '--json']);
  assert.equal(result.code, 0, result.stderr);

  const check = new DatabaseSync(file);
  assert.equal(
    check.prepare('SELECT status FROM runs WHERE id=?').get('child-crashed')?.status,
    'interrupted',
  );
  assert.equal(
    check.prepare('SELECT active_run FROM sessions WHERE id=?').get(child.id)?.active_run,
    null,
  );
  assert.equal(
    check.prepare('SELECT status FROM runs WHERE id=?').get('parent-crashed')?.status,
    'interrupted',
  );
  assert.equal(
    check.prepare('SELECT active_run FROM sessions WHERE id=?').get(parent.id)?.active_run,
    null,
  );
  check.close();
  const log = new SessionStore(file);
  assert.deepEqual(
    log
      .events(parent.id)
      .filter((event) => event.type === 'run.interrupted')
      .map((event) => event.data),
    [
      {
        runId: 'parent-crashed',
        pendingCalls: 0,
        reason:
          'Previous run was interrupted. Execution outcome is unknown; inspect current state before retrying.',
      },
    ],
  );
  log.close();
});

test('CLI names why a run failed, in the line a person reads and in the JSON a program reads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture is down' } }));
  });
  const env = {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
    // No retries: this test is about the failure being named, not about how long it takes to give up.
    YUANTU_MAX_RETRIES: '0',
  };
  const human = await runCli(['run', 'Anything', '--workspace', root], env);
  assert.notEqual(human.code, 0);
  // The status, the message and — in parentheses — the machine-readable reason.
  assert.match(human.stderr, /\[failed\]/);
  assert.match(human.stderr, /HTTP 503/);
  assert.match(human.stderr, /\(server\)/);
  const machine = await runCli(['run', 'Anything', '--workspace', root, '--json'], env);
  assert.notEqual(machine.code, 0);
  const final = JSON.parse(machine.stdout.trim().split('\n').at(-1)!);
  assert.equal(final.type, 'result');
  assert.equal(final.result.status, 'failed');
  assert.equal(final.result.code, 'server');
});

test('CLI reports a re-sent request instead of looking stuck', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(503, { 'retry-after': '0', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: 'Fine' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  const result = await runCli(['run', 'Anything', '--workspace', root], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
    OPENAI_API_KEY: 'fixture-secret',
    YUANTU_PROTOCOL: 'openai',
    YUANTU_MAX_RETRIES: '1',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 2);
  assert.match(result.stderr, /\[retry\] server, re-sending in \d+ms \(attempt 1 of 1\)/);
  assert.match(result.stdout, /Fine/);
});

test('CLI names the model a re-aimed round actually used', async (t) => {
  // The seam is reachable from a carrier: a trusted hooks module may return `{model, reasoningEffort}` from its
  // round preamble, and the operator has to be able to see that it happened — a run whose rounds silently cost
  // two different prices is exactly what a settled CLI must not do.
  const base = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-reaim-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(base, 'workspace');
  const shared = path.join(base, 'shared');
  await mkdir(workspace, { recursive: true });
  await mkdir(shared, { recursive: true });
  const hooks = path.join(shared, 'hooks.mjs');
  await writeFile(
    hooks,
    "export const hooks = { preStep: (context) => (context.round === 0 ? { model: 'small-model', reasoningEffort: 'low' } : undefined) };\n",
  );
  const models: string[] = [];
  const bodies: any[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    models.push(String(body.model));
    // One tool round first, so the run makes two requests and the *first* is the re-aimed one.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = bodies.length === 1;
    res.end(
      'data: ' +
        JSON.stringify(
          first
            ? {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-1',
                          function: { name: 'read_file', arguments: '{"path":"missing.txt"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
              }
            : {
                choices: [{ index: 0, delta: { content: 'Fine' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
              },
        ) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  const result = await runCli(['run', 'Anything', '--workspace', workspace, '--hooks', hooks], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'configured-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
    OPENAI_API_KEY: 'fixture-secret',
    YUANTU_PROTOCOL: 'openai',
  });
  assert.equal(result.code, 0, result.stderr);
  // The first request was re-aimed and the second was not: an override is per round, not per run.
  assert.deepEqual(models, ['small-model', 'configured-model']);
  assert.equal(bodies[0]!.reasoning_effort, 'low');
  assert.equal(bodies[1]!.reasoning_effort, undefined);
  assert.match(result.stderr, /\[model\] round 1: small-model \(effort low\)/);
  assert.match(result.stderr, /\[model\] round 2: configured-model/);
});

test('a run with an active goal continues on its own until the goal is finished', async (t) => {
  /**
   * The end-to-end claim of the continuation driver: one command, more than one run. Run 1 creates the goal and
   * finishes; the loop reads the goal back from the durable log, starts round 2 with the continuation prompt,
   * and stops when that round records the goal complete. Without the driver there would be a single `result`.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts: string[] = [];
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    prompts.push(JSON.stringify(body.messages));
    step++;
    if (step === 1)
      sendFrames(
        res,
        frames('Creating the goal.', [
          { id: 'goal-1', name: 'create_goal', input: { objective: 'Ship the migration' } },
        ]),
      );
    else if (step === 2) sendFrames(res, frames('Round one is done.'));
    else if (step === 3)
      sendFrames(
        res,
        frames('Goal complete.', [
          { id: 'goal-2', name: 'update_goal', input: { action: 'complete' } },
        ]),
      );
    else sendFrames(res, frames('Done.'));
  });
  const result = await runCli(['run', 'Ship the migration', '--workspace', root, '--json'], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    ANTHROPIC_API_KEY: 'fixture-secret',
  });
  assert.equal(result.code, 0, result.stderr);
  const results = result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.includes('"type":"result"'));
  assert.equal(results.length, 2, `expected two runs: ${result.stdout}`);
  // The continuation is a round like any other, and it says which round it is and what it is for.
  assert.match(prompts[2]!, /round 2 of 256/);
  assert.match(prompts[2]!, /Ship the migration/);
  assert.match(result.stderr, /\[goal\] round 2/);
  assert.match(result.stderr, /\[goal\] stopped after 1 round\(s\): goal/);
});

test('models reads the window from the endpoint instead of guessing one', async (t) => {
  const url = await httpFixture(t, (_body, res, _headers, requestPath) => {
    if (!requestPath.startsWith('/v1/models')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'fixture-model', context_length: 128000, max_output_tokens: 8192 },
          { id: 'other-model', context_window: 64000 },
          { id: 'silent-model' },
        ],
      }),
    );
  });
  const env = {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    ANTHROPIC_API_KEY: 'fixture-secret',
  };
  const json = await runCli(['models', '--json'], env);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    endpoint: `${url}/v1/models`,
    protocol: 'anthropic',
    models: [
      { id: 'fixture-model', name: 'fixture-model', contextWindow: 128000, maxOutputTokens: 8192 },
      { id: 'other-model', name: 'other-model', contextWindow: 64000 },
      // A catalogue entry with no capacity field is listed as such rather than given a number.
      { id: 'silent-model', name: 'silent-model' },
    ],
  });
  // The human form is the one an operator copies from, so it marks the model this connection is configured
  // with and says what to do with the number.
  const human = await runCli(['models'], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(
    human.stdout,
    /fixture-model {2}\(window 128000, max output 8192\) {3}← YUANTU_MODEL/,
  );
  assert.match(human.stdout, /other-model {2}\(window 64000\)/);
  assert.match(human.stdout, /silent-model {2}\(window not declared\)/);
  assert.match(human.stdout, /--max-context-tokens/);
});

test('a CLI run with no declared window discovers its budget and completes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-auto-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let probes = 0;
  const url = await httpFixture(t, (body, res, _headers, requestUrl) => {
    if (requestUrl === '/v1/models') {
      probes++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'fixture-model', context_length: 96000, max_output_tokens: 4096 }],
        }),
      );
      return;
    }
    assert.equal(body.max_tokens, 4096);
    sendFrames(res, frames('Done with automatic capacity.'));
  });
  const result = await runCli(['run', 'Do something', '--json', '--workspace', root], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    ANTHROPIC_API_KEY: 'fixture-secret',
    YUANTU_MAX_CONTEXT_TOKENS: '',
    YUANTU_MAX_OUTPUT_TOKENS: '',
    YUANTU_MODEL_CAPACITIES: '',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(probes, 1);
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    const envelope = store
      .events(store.list('', root)[0]!.id)
      .find((event) => event.type === 'context.envelope');
    assert.equal(envelope?.data.maxContextTokens, 96000);
  } finally {
    store.close();
  }
});

/**
 * The money line for "where did the window go".
 *
 * `context.forecast` has carried a per-section breakdown for a while and nothing human read it; the CLI now
 * prints it, and only when it says something that changed — the first round (the baseline) and any round the
 * budget was acted on. This test pins the reader, not the numbers: the tool catalogue is the fixed cost the
 * line exists to expose, so it has to be visible and it has to be *one* line for a one-round run.
 */
test('the CLI prints where the round’s window went, once, on stderr', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('Done.')));
  const result = await runCli(['run', 'Say done', '--workspace', root], {
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
  });
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stderr.split('\n').filter((line) => line.includes('[budget]'));
  assert.equal(lines.length, 1, `one round is one budget line, not a ticker: ${result.stderr}`);
  assert.match(
    lines[0]!,
    /^\[budget\] round 1: system \d+ · tools \d+ · messages \d+ · overhead \d+ = \d+/,
  );
  const tools = Number(/tools (\d+)/.exec(lines[0]!)?.[1] ?? 0);
  assert.ok(
    tools > 1000,
    `the tool catalogue is the fixed cost the line exists to show: ${lines[0]}`,
  );
});

/**
 * The usage line accounts for the cache exactly as far as the provider did.
 *
 * The numbers were parsed into `Usage` and shown in the desktop's statistics all along, but the *result's*
 * usage was hand-summed from two fields, so `cachedInputTokens` never survived the trip to `RunResult.usage` —
 * the CLI could not have printed a hit rate from it. That is fixed in the agent's two `onUsage` accumulators,
 * and this test is the end-to-end proof: a fixture that reports a cache read and a write produces the note, and
 * a fixture that reports neither produces no note at all ("unreported" and "zero" are different facts).
 */
test('the CLI usage line reports the cache the provider reported, and only that', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = (url: string) => ({
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture-model',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    ANTHROPIC_API_KEY: 'fixture-secret',
  });
  const withCache = await httpFixture(t, (_body, res) => {
    const events = frames('Done.');
    // 100 fresh input tokens, 80 read from cache, 20 written: the adapter sums all three into `inputTokens`,
    // so the hit rate is 80/200 = 40%.
    (events[0] as { message: { usage: Record<string, number> } }).message.usage = {
      input_tokens: 100,
      output_tokens: 0,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    };
    sendFrames(res, events);
  });
  const reported = await runCli(['run', 'Say done', '--workspace', root], env(withCache));
  assert.equal(reported.code, 0, reported.stderr);
  assert.match(
    reported.stderr,
    /tokens: 200 in \/ \d+ out \(cache: 40% hit, 80 of 200 read, 20 written\)/,
    `the cache is accounted for where the provider reported it: ${reported.stderr}`,
  );

  const plain = await httpFixture(t, (_body, res) => sendFrames(res, frames('Done.')));
  const silent = await runCli(['run', 'Say done', '--workspace', root], env(plain));
  assert.equal(silent.code, 0, silent.stderr);
  const usage = silent.stderr.split('\n').find((line) => line.includes('tokens:')) ?? '';
  assert.match(usage, /tokens: \d+ in \/ \d+ out/);
  assert.ok(!usage.includes('cache:'), `an unreported cache is not a zero one: ${usage}`);
});

test('a credential is stored from standard input and is never printed back', async (t) => {
  /**
   * The command exists because the runtime had one way to hold a key: an exported variable. It reads the key from
   * standard input rather than from an argument, since an argument is visible in the process table and the shell
   * history, and it never echoes the key in either direction — a command that can print a secret puts it in
   * scrollback and in whatever collects that.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cli-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'credentials.json');
  const env = { YUANTU_CREDENTIALS_FILE: file };
  const stored = await runCli(['credentials', 'set', 'anthropic'], env, 'sk-ant-from-stdin\n');
  assert.equal(stored.code, 0, stored.stderr);
  assert.doesNotMatch(
    `${stored.stdout}${stored.stderr}`,
    /sk-ant-from-stdin/,
    'the key is not echoed, not even in the confirmation',
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { anthropic: 'sk-ant-from-stdin' });
  const listed = await runCli(['credentials', 'list'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /anthropic/);
  assert.doesNotMatch(
    listed.stdout,
    /sk-ant-from-stdin/,
    'listing names the protocols, never the keys',
  );
  // The rule the adapters apply, at the moment somebody can still fix it.
  const refused = await runCli(['credentials', 'set', 'anthropic'], env, 'sk-broken\nkey\n');
  assert.notEqual(refused.code, 0, 'a key that cannot travel in a header is refused');
  assert.match(refused.stderr, /control character/);
});

test('the CLI lists every setting it reads, and never prints a credential', async () => {
  /**
   * The discoverability half of `ENVIRONMENT.description`: the help text carries a hand-picked handful of names,
   * and the full table lived only in the generated README. `env` prints the table the program itself reads, so a
   * name that exists cannot be missing and one that does not exist cannot appear — which is what makes this a
   * check on the code rather than on a copy of it.
   *
   * The redaction is the same rule `credentials list` follows: a command that can print a secret puts it in
   * scrollback and in whatever collects a terminal's output. Asserted with a value that would be unmistakable in
   * the output, in both the text and the JSON form.
   */
  const listed = await runCli(['env', '--json'], {
    YUANTU_API_KEY: 'sk-must-not-appear',
    YUANTU_MODEL: 'fixture-model',
  });
  assert.equal(listed.code, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as {
    name: string;
    shape: string;
    value: string | null;
    description: string;
  }[];
  const expected = Object.keys(ENVIRONMENT);
  assert.deepEqual(
    rows.map((row) => row.name),
    expected,
    'the listing is the table, in its own order',
  );
  assert.ok(
    rows.every((row) => row.shape && row.description),
    'every row says what it takes and what it is for',
  );
  const key = rows.find((row) => row.name === 'YUANTU_API_KEY')!;
  assert.equal(key.value, '[redacted]', 'a credential is reported as present, never as itself');
  assert.doesNotMatch(listed.stdout, /sk-must-not-appear/);
  assert.equal(rows.find((row) => row.name === 'YUANTU_MODEL')!.value, 'fixture-model');
  const text = await runCli(['env'], { YUANTU_API_KEY: 'sk-must-not-appear' });
  assert.equal(text.code, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /sk-must-not-appear/);
  assert.match(text.stdout, /YUANTU_API_KEY/);
  const refused = await runCli(['env', 'extra']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Usage: env/);
});
