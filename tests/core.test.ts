import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
import type {
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  AgentEvent,
  Approver,
} from '../packages/protocol/index.ts';
import { RunQueue } from '../packages/core/run-queue.ts';
import { emptyStatistics, addStatistics, addUsage } from '../packages/protocol/statistics.ts';
import { redactSecrets } from '../packages/platform/redact.ts';
import { ToolProgressGuard } from '../packages/core/tool-progress.ts';
import { RunSurface } from '../packages/core/run-surface.ts';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import { storeFixture } from './temp-fixture.ts';

/**
 * The user-role messages a person actually typed.
 *
 * The runtime announces built-in skills as a user-role message, so a conversation's message count includes
 * machine context. Tests that count turns or look for the first human turn must exclude it, not pin the
 * announcement's presence or absence.
 */
const typedUserMessages = (messages: readonly Message[]): Extract<Message, { role: 'user' }>[] =>
  messages.filter(
    (message): message is Extract<Message, { role: 'user' }> =>
      message.role === 'user' && !isRuntimeContext(message.content),
  );

test('changing queries and scratch probes cannot extend investigation indefinitely', async (t) => {
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      requests++;
      if (!request.tools.length) return reply('Conclusion from collected evidence');
      if (requests > 25) return reply('Investigation failed to converge');
      return {
        ...reply(),
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: `probe-${requests}`,
            name: 'write_file',
            arguments: {
              path: `.scratch/probe-${requests}.txt`,
              content: `new evidence ${requests}`,
            },
          },
        ],
      };
    },
  });
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'Why is it slow?',
    autoVerify: true,
  });
  assert.equal(result.text, 'Conclusion from collected evidence');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion, undefined);
  // Twenty investigation rounds, three act attempts, then the conclusion.
  assert.ok(requests <= 24, `${requests} requests`);
});

test('investigation wall time converges even when each query returns new evidence', () => {
  let now = 0;
  const guard = new ToolProgressGuard({ now: () => now });
  const read = (path: string) => [
    {
      call: { id: path, name: 'read_file', arguments: { path } },
      result: { isError: false, content: path },
    },
  ];
  assert.equal(guard.observeRound(read('a')), 'continue');
  // The default allowance is 240 s, and the nudge to start editing is half of it (see `RunDefaults`).
  now = 125_000;
  assert.equal(guard.observeRound(read('b')), 'investigation-warn');
  now = 245_000;
  assert.equal(guard.observeRound(read('c')), 'investigation-conclude');
  guard.reset();
  assert.equal(guard.observeRound(read('d')), 'continue');
});

test('the investigation allowance is configurable, and its nudge is half of it', () => {
  let now = 0;
  const guard = new ToolProgressGuard({ now: () => now, investigationMs: 40_000 });
  const read = () => [
    {
      call: { id: 'read', name: 'read_file', arguments: { path: 'a.txt' } },
      result: { isError: false, content: 'stable' },
    },
  ];
  assert.equal(guard.observeRound(read()), 'continue');
  now = 20_000;
  assert.equal(guard.observeRound(read()), 'investigation-warn');
  now = 40_000;
  assert.equal(guard.observeRound(read()), 'investigation-conclude');
  // A configured allowance is what the guard uses: the same clock would still be inside the default one.
  const defaults = new ToolProgressGuard({ now: () => 20_000 });
  assert.equal(defaults.observeRound(read()), 'continue');
});

// ---- merged from core.test.ts ----

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
async function fixture(t: test.TestContext, provider: Provider, extra = {}) {
  const { root, store, session } = await storeFixture(t, 'yuantu-core-');
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { root, store, session, agent, events, tools };
}

for (const finishReason of ['stop', 'tool_calls', 'length'] as const)
  test(`reported output above the requested cap is limited before tools run (${finishReason})`, async (t) => {
    const ctx = await fixture(
      t,
      {
        async complete(request) {
          assert.equal(request.maxOutputTokens, 64);
          return {
            ...reply('Retained partial answer'),
            finishReason,
            usage: { inputTokens: 10, outputTokens: 500 },
            toolCalls:
              finishReason === 'tool_calls'
                ? [
                    {
                      id: 'must-not-run',
                      name: 'write_file',
                      arguments: { path: 'unexpected.txt', content: 'bad' },
                    },
                  ]
                : [],
          };
        },
      },
      { maxOutputTokens: 64, maxModelRetries: 0 },
    );
    const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Reply briefly' });
    assert.equal(result.status, 'limited');
    assert.equal(result.code, 'output-limit');
    assert.match(result.error ?? '', /500\/64 output tokens/);
    assert.equal(result.usage.outputTokens, 500);
    assert.equal(ctx.events.filter((e) => e.type === 'tool.started').length, 0);
    const partial = ctx.store
      .messages(ctx.session.id)
      .find((message) => message.role === 'assistant');
    assert.ok(partial?.role === 'assistant');
    assert.equal(partial.content, 'Retained partial answer');
    assert.equal(partial.interrupted, true);
    await assert.rejects(readFile(path.join(ctx.root, 'unexpected.txt')), { code: 'ENOENT' });
  });

test('a normal stop exactly at the requested output cap remains completed', async (t) => {
  const ctx = await fixture(
    t,
    {
      async complete() {
        return { ...reply(), usage: { inputTokens: 10, outputTokens: 64 } };
      },
    },
    { maxOutputTokens: 64 },
  );
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Reply briefly' })).status,
    'completed',
  );
});

test('an empty over-cap response retains its billed usage and is never retried', async (t) => {
  let calls = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        calls++;
        return { ...reply(''), usage: { inputTokens: 10, outputTokens: 500 } };
      },
    },
    { maxOutputTokens: 64, maxModelRetries: 2 },
  );
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Reply briefly' });
  assert.equal(result.status, 'limited');
  assert.equal(result.code, 'output-limit');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 500 });
  assert.equal(calls, 1);
});

const fileEditors = [
  'apply_patch',
  'batch_edit',
  'delete_file',
  'edit_file',
  'move_file',
  'write_file',
];
const toolReply = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  ...reply(),
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
});
const readRound = (round: number) =>
  toolReply(`read-${round}`, 'read_file', {
    path: round === 1 ? 'target.txt' : `input-${round}.txt`,
  });
const editRound = (id: string, old_text = 'bad') =>
  toolReply(id, 'edit_file', { path: 'target.txt', old_text, new_text: 'good' });

/**
 * Advance only model requests; Date mocks do not drive RunSteps.modelMs.
 *
 * One tick is a minute of model time: four of them reach the 240 s allowance the default now sets, which is what
 * these tests are about. The nudge fires halfway through, at 120 s, which is two ticks.
 */
function investigationClock(t: test.TestContext): () => void {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  return () => {
    now += 60_000;
  };
}
async function investigationFiles(root: string) {
  await Promise.all([
    mkdir(path.join(root, '.scratch'), { recursive: true }),
    writeFile(path.join(root, 'target.txt'), 'bad'),
    ...Array.from({ length: 4 }, (_, i) =>
      writeFile(path.join(root, `input-${i + 1}.txt`), `evidence ${i}`),
    ),
  ]);
}
function assertActTools(request: ModelRequest) {
  assert.deepEqual(
    request.tools.map((tool) => tool.name).sort(),
    [...fileEditors, 'read_file'].sort(),
  );
  assert.ok(
    request.tools.some((tool) => tool.name === 'edit_file'),
    'editing remains available at the cutoff',
  );
  assert.ok(
    request.tools.every((tool) => [...fileEditors, 'read_file'].includes(tool.name)),
    'only file editors and targeted reads are offered',
  );
  assert.ok(
    request.tools.every((tool) => !('effect' in tool)),
    'internal effect metadata stays off the wire',
  );
}

test('investigation cutoff offers editors, persists an edit and restores both catalogs', async (t) => {
  const tick = investigationClock(t);
  const catalogs: string[][] = [];
  const refresh = RunSurface.prototype.refreshTools;
  t.mock.method(RunSurface.prototype, 'refreshTools', function (this: RunSurface) {
    refresh.call(this);
    catalogs.push(this.catalog.map((tool) => tool.name));
  });
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      if (round <= 4) {
        tick();
        return readRound(round);
      }
      if (round === 5) {
        assertActTools(request);
        assert.equal(ctx.tools.offers('read_file'), true);
        assert.ok(catalogs.at(-1)?.every((name) => [...fileEditors, 'read_file'].includes(name)));
        return editRound('act-edit');
      }
      assert.ok(
        request.tools.some((tool) => tool.name === 'read_file'),
        JSON.stringify(request.messages.filter((m) => m.role === 'tool').slice(-2)),
      );
      assert.ok(catalogs.at(-1)?.includes('read_file'));
      return reply('Changed; verification unavailable');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'Fix target.txt',
    autoVerify: true,
  });
  assert.equal(result.status, 'needs_review', result.error);
  assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'good');
  assert.equal(ctx.tools.offers('read_file'), true);
  assert.equal(requests, 7, 'one automatic verification reminder follows the first answer');
});

test('investigation cutoff still accepts a direct answer without project changes', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      if (++requests <= 4) {
        tick();
        return readRound(requests);
      }
      assertActTools(request);
      return reply('Answer from collected evidence');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Explain the evidence' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Answer from collected evidence');
  assert.equal(requests, 5);
  assert.equal(ctx.tools.offers('read_file'), true);
});

test('investigation cutoff capabilities identify exactly the six file editors', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply();
    },
  });
  assert.deepEqual(ctx.tools.namesWithEffect('workspace-file').sort(), fileEditors);
  assert.ok(ctx.tools.specs({ mode: 'native' }).every((tool) => !('effect' in tool)));
});

for (const attempt of [
  'failed-edit',
  'scratch',
  'forbidden-search',
  'forbidden-program',
  'read-only',
] as const) {
  test(`investigation cutoff bounds three no-change attempts: ${attempt}`, async (t) => {
    const tick = investigationClock(t);
    let requests = 0;
    const ctx = await fixture(t, {
      async complete(request) {
        const round = ++requests;
        if (round <= 4) {
          tick();
          return readRound(round);
        }
        if (round <= 7) {
          assertActTools(request);
          if (attempt === 'failed-edit') return editRound(`attempt-${round}`, 'absent');
          if (attempt === 'scratch')
            return toolReply(`attempt-${round}`, 'write_file', {
              path: `.scratch/act-${round}.txt`,
              content: 'probe',
            });
          if (attempt === 'forbidden-program')
            return toolReply(`attempt-${round}`, 'run_code', {
              code: "return await tools.read_file({path:'target.txt'});",
            });
          return toolReply(
            `attempt-${round}`,
            attempt === 'read-only' ? 'read_file' : 'search_files',
            { path: 'target.txt', ...(attempt === 'read-only' ? {} : { pattern: 'bad' }) },
          );
        }
        assert.equal(round, 8);
        assert.deepEqual(request.tools, []);
        assert.equal(
          ctx.tools.offers('read_file'),
          true,
          'the act restriction is released even in conclusion',
        );
        return reply('Stopped without changes');
      },
    });
    await investigationFiles(ctx.root);
    const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(requests, 8);
    assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'bad');
    const results = ctx.store
      .messages(ctx.session.id)
      .filter((m) => m.role === 'tool' && m.toolCallId.startsWith('attempt-'));
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result.role === 'tool');
      assert.equal(
        result.isError,
        attempt !== 'scratch' && attempt !== 'read-only',
        result.content,
      );
      if (attempt.startsWith('forbidden'))
        assert.match(result.content, /excluded by a restriction/);
    }
    assert.equal(
      ctx.events.filter(
        (e) => e.type === 'context.injected' && e.data.action === 'investigation-conclude',
      ).length,
      1,
    );
    assert.equal(ctx.tools.offers('read_file'), true);
  });
}

test('investigation cutoff refuses a mixed search but executes its sibling edit', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      if (++requests <= 4) {
        tick();
        return readRound(requests);
      }
      if (requests === 5) {
        assertActTools(request);
        const response = editRound('mixed-edit');
        response.toolCalls.unshift({
          id: 'mixed-read',
          name: 'search_files',
          arguments: { path: 'target.txt', pattern: 'bad' },
        });
        return response;
      }
      assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
      const denied = request.messages.find(
        (m) => m.role === 'tool' && m.toolCallId === 'mixed-read',
      );
      assert.ok(denied?.role === 'tool' && denied.isError);
      assert.match(denied.content, /excluded by a restriction/);
      return reply('Edited');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'good');
});

for (const ending of ['exception', 'cancel', 'conclusion-call'] as const) {
  test(`investigation cutoff releases restrictions after ${ending} and a later run can read`, async (t) => {
    const tick = investigationClock(t);
    const controller = new AbortController();
    let requests = 0;
    let laterRun = false;
    const ctx = await fixture(t, {
      async complete(request) {
        if (laterRun) {
          assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
          return reply('Later answer');
        }
        if (++requests <= 4) {
          tick();
          return readRound(requests);
        }
        if (ending === 'conclusion-call') {
          if (requests <= 7) {
            assertActTools(request);
            return editRound(`failed-${requests}`, 'absent');
          }
          assert.deepEqual(request.tools, []);
          return readRound(1);
        }
        assertActTools(request);
        if (ending === 'cancel') {
          controller.abort(new Error('Cancelled by test'));
          request.signal.throwIfAborted();
        }
        throw new Error('Provider failure in act phase');
      },
    });
    await investigationFiles(ctx.root);
    const result = await ctx.agent.run({
      sessionId: ctx.session.id,
      prompt: 'Fix target.txt',
      signal: controller.signal,
    });
    assert.equal(
      result.status,
      ending === 'cancel' ? 'cancelled' : ending === 'conclusion-call' ? 'needs_review' : 'failed',
    );
    if (ending === 'exception') assert.match(result.error ?? '', /Provider failure in act phase/);
    assert.equal(ctx.tools.offers('read_file'), true);
    laterRun = true;
    assert.equal(
      (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Explain' })).status,
      'completed',
    );
  });
}

test('investigation cutoff preserves identical failure counts across a successful act edit', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      if (round <= 4) tick();
      if (round <= 3 || round === 6 || round === 7)
        return toolReply(`failure-${round}`, 'missing_tool', {});
      if (round === 4) return readRound(1);
      if (round === 5) {
        assertActTools(request);
        return editRound('successful-act');
      }
      assert.equal(round, 8);
      assert.deepEqual(request.tools, []);
      return reply('Repeated failure stopped');
    },
  });
  await investigationFiles(ctx.root);
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' })).status,
    'completed',
  );
  assert.equal(requests, 8);
  assert.ok(
    ctx.events.some((e) => e.type === 'context.injected' && e.data.action === 'repeat-failure'),
  );
  assert.ok(ctx.events.some((e) => e.type === 'context.injected' && e.data.action === 'conclude'));
});

test('investigation cutoff consumes follow-up input and restores tools and a fresh allowance', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      if (++requests <= 4) {
        tick();
        return readRound(requests);
      }
      if (requests === 5) {
        assertActTools(request);
        return editRound('failed-act', 'absent');
      }
      if (requests === 6) {
        assertActTools(request);
        ctx.agent.enqueue(
          ctx.session.id,
          { prompt: 'Explain the existing evidence instead' },
          'follow-up',
        );
        return reply('First answer');
      }
      assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
      if (requests === 7) return readRound(1);
      assert.equal(requests, 8);
      return reply('Follow-up answer');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.text, 'Follow-up answer');
  assert.equal(result.status, 'completed', result.error);
});

for (const tighten of [false, true]) {
  test(`investigation cutoff clears act restrictions after a policy change (read-only=${tighten})`, async (t) => {
    const tick = investigationClock(t);
    let policy = new PermissionPolicy({ version: 1, rules: [] });
    let requests = 0;
    const ctx = await fixture(
      t,
      {
        async complete(request) {
          if (++requests <= 4) {
            tick();
            return readRound(requests);
          }
          if (requests === 5) {
            assertActTools(request);
            policy = new PermissionPolicy({
              version: 1,
              rules: tighten ? [{ effect: 'deny', kind: 'write' }] : [],
            });
            return editRound('failed-before-policy', 'absent');
          }
          assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
          assert.equal(
            request.tools.some((tool) => tool.name === 'edit_file'),
            !tighten,
          );
          if (requests === 6) return tighten ? editRound('denied-by-policy') : readRound(1);
          assert.equal(requests, 7);
          if (tighten) {
            const denied = request.messages.find(
              (m) => m.role === 'tool' && m.toolCallId === 'denied-by-policy',
            );
            assert.ok(denied?.role === 'tool' && denied.isError);
            assert.match(denied.content, /denied|refused/i);
          }
          return reply('Policy refreshed');
        },
      },
      {
        permissionPolicy: () => policy,
        approve: async (approval: Parameters<Approver>[0]) => policy.decide(approval) !== 'deny',
      },
    );
    await investigationFiles(ctx.root);
    const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'bad');
  });
}

test('investigation cutoff at the plan approval boundary restores the approved catalog', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(
    t,
    {
      async complete(request) {
        if (++requests <= 3) {
          tick();
          return readRound(requests);
        }
        if (requests === 4) {
          tick();
          return toolReply('approve-plan', 'exit_plan_mode', {
            title: 'Fix target',
            summary: 'Make a minimal edit',
            steps: ['Edit target.txt'],
          });
        }
        assert.ok(
          request.tools.some((tool) => tool.name === 'read_file'),
          JSON.stringify(request.messages.filter((m) => m.role === 'tool').slice(-2)),
        );
        assert.ok(request.tools.some((tool) => tool.name === 'edit_file'));
        return reply('Approved catalog restored');
      },
    },
    {
      question: async () => ({
        answered: true,
        answers: [{ id: 'plan', selected: ['Approve and execute'] }],
      }),
    },
  );
  await investigationFiles(ctx.root);
  const plan = ctx.store.createPlan(ctx.session.id);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'Plan a fix',
    planPhase: true,
    planId: plan.id,
  });
  assert.notEqual(result.status, 'failed', result.error);
  assert.equal(requests, 5);
  assert.equal(ctx.tools.offers('read_file'), true);
});

test('investigation cutoff allows three targeted reads under a read-only request', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      if (++requests <= 4) {
        tick();
        return readRound(requests);
      }
      if (requests <= 7) {
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ['read_file'],
        );
        return readRound(1);
      }
      assert.deepEqual(request.tools, []);
      return reply('Read-only conclusion');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'Explain',
    readOnly: true,
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 8);
});

test('investigation cutoff yields to the ordinary failure conclusion during the first act attempt', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      if (round <= 4) {
        tick();
        return editRound(`failure-${round}`, 'absent');
      }
      if (round === 5) {
        assertActTools(request);
        return editRound('last-failure', 'absent');
      }
      assert.equal(round, 6, 'the fifth identical failure ends act before its second attempt');
      assert.deepEqual(request.tools, []);
      return reply('Failure limit reached');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 6);
});

test('investigation handoff reads exact source before editing and restores searches', async (t) => {
  const tick = investigationClock(t);
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      const round = ++requests;
      if (round <= 4) {
        tick();
        return readRound(round);
      }
      if (round === 5) {
        assertActTools(request);
        const notice = JSON.stringify(request.messages);
        assert.match(notice, /do not reconstruct/i);
        assert.match(notice, /read_file/);
        assert.match(notice, /line range/i);
        return toolReply('targeted-read', 'read_file', {
          path: 'target.txt',
          start_line: 1,
          end_line: 1,
        });
      }
      if (round === 6) {
        assertActTools(request);
        return editRound('after-read');
      }
      assert.ok(request.tools.some((tool) => tool.name === 'search_files'));
      return reply('Edited after checking source');
    },
  });
  await investigationFiles(ctx.root);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Fix target.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(path.join(ctx.root, 'target.txt'), 'utf8'), 'good');
  assert.equal(requests, 7);
});

test('ordinary questions carry direct-answer and scoped-project lookup rules', async (t) => {
  let requests = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      requests++;
      assert.match(request.system, /answer directly without tools/i);
      assert.match(request.system, /relevant paths and symbols/i);
      return reply('A closure retains access to its surrounding scope.');
    },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: '什么是闭包？' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 1);
  assert.equal(ctx.events.filter((event) => event.type === 'tool.started').length, 0);
});

for (const mode of ['native', 'program'] as const) {
  test(`unchanged ${mode} reads converge to an answer without more tools`, async (t) => {
    let requests = 0;
    let finalOnly = false;
    const ctx = await fixture(t, {
      async complete(request) {
        requests++;
        if (request.tools.length === 0) {
          finalOnly = true;
          return reply('The file is unchanged; no additional evidence was found.');
        }
        if (requests > 6) return reply('Unexpectedly kept rereading.');
        return {
          ...reply('Checking'),
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'repeat-' + requests,
              name: mode === 'native' ? 'read_file' : 'run_code',
              arguments:
                mode === 'native'
                  ? { path: 'a.txt' }
                  : { code: "return await tools.read_file({path:'a.txt'});" },
            },
          ],
        };
      },
    });
    await writeFile(path.join(ctx.root, 'a.txt'), 'stable content');
    const result = await ctx.agent.run({
      sessionId: ctx.session.id,
      prompt: '解释 a.txt 的内容，不要修改',
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(finalOnly, true, 'a repeated unchanged query must reach a tool-free conclusion');
    assert.ok(requests <= 5, `too many requests: ${requests}`);
    assert.ok(
      ctx.events.some(
        (event) => event.type === 'context.injected' && event.data.source === 'tool-progress',
      ),
    );
    assert.equal(
      ctx.store.messages(ctx.session.id).filter((m) => m.role === 'tool').length,
      requests - 1,
    );
  });
}

test('query convergence resets for new evidence, mutations, polls and user steering', () => {
  const guard = new ToolProgressGuard();
  const query = (name = 'read_file', content = 'stable') => [
    {
      call: { id: 'observation', name, arguments: { path: 'a.txt' } },
      result: { isError: false, content },
    },
  ];
  assert.equal(guard.observeRound(query()), 'continue');
  assert.equal(guard.observeRound(query()), 'continue');
  assert.equal(guard.observeRound(query()), 'warn');
  assert.equal(guard.observeRound(query('read_file', 'new evidence')), 'continue');
  assert.equal(guard.observeRound(query('write_file')), 'continue');
  assert.equal(guard.observeRound(query()), 'continue');
  assert.equal(guard.observeRound(query('job_output')), 'continue');
  for (let i = 0; i < 8; i++) assert.equal(guard.observeRound(query('job_output')), 'continue');
  guard.observeRound(query());
  guard.observeRound(query());
  guard.observeRound(query());
  guard.reset();
  assert.equal(guard.observeRound(query()), 'continue');
});

test('the same failure after edits in between is noticed, then concluded', () => {
  const guard = new ToolProgressGuard();
  const edit = {
    call: { id: 'edit', name: 'write_file', arguments: { path: 'a.ts' } },
    result: { isError: false, content: 'written' },
  };
  const test = (output = 'FAIL expected 1, got 2') => ({
    call: { id: 'test', name: 'run_command', arguments: { command: 'npm test' } },
    result: { isError: true, content: output },
  });
  assert.equal(guard.observeRound([edit, test()]), 'continue');
  assert.equal(guard.observeRound([edit, test()]), 'continue');
  assert.equal(guard.observeRound([edit, test()]), 'repeat-failure');
  // A failure that changed is progress, and does not move the count of the old one.
  assert.equal(guard.observeRound([edit, test('FAIL expected 1, got 3')]), 'continue');
  assert.equal(guard.observeRound([edit, test()]), 'continue');
  assert.equal(guard.observeRound([edit, test()]), 'conclude');
  // A person stepping in starts the count over.
  guard.reset();
  assert.equal(guard.observeRound([edit, test()]), 'continue');
});

test('programs deriving new results from the same file are not unchanged queries', async (t) => {
  let turns = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      turns++;
      if (!request.tools.length) return reply('Stopped before all calculations');
      if (turns > 6) return reply('All calculations finished');
      return {
        ...reply(),
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'calculation-' + turns,
            name: 'run_code',
            arguments: {
              code: `const text=await tools.read_file({path:'a.txt'}); return text.slice(0,${turns});`,
            },
          },
        ],
      };
    },
  });
  await writeFile(path.join(ctx.root, 'a.txt'), 'abcdefghijklmnop');
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: '逐步分析 a.txt 的内容',
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'All calculations finished');
  assert.equal(turns, 7);
});

test('a model asking for more tools in the conclusion round cannot execute them', async (t) => {
  let requests = 0;
  const ctx = await fixture(t, {
    async complete() {
      if (++requests > 6) return reply('unexpected extra requests');
      return {
        ...reply('Reading'),
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'same-' + requests, name: 'read_file', arguments: { path: 'a.txt' } }],
      };
    },
  });
  await writeFile(path.join(ctx.root, 'a.txt'), 'stable');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: '查看 a.txt' });
  assert.equal(result.status, 'needs_review', result.error);
  assert.equal(ctx.events.filter((e) => e.type === 'tool.started').length, 4);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
  const messages = ctx.store.messages(ctx.session.id);
  assert.ok(
    messages.some((m) => m.role === 'tool' && m.isError && m.content.includes('Not executed')),
  );
});

test('a new user instruction restores tools after query convergence', async (t) => {
  let turns = 0,
    steered = false;
  const ctx = await fixture(t, {
    async complete(request) {
      if (++turns > 7) return reply('too many turns');
      if (!request.tools.length) {
        ctx.agent.enqueue(ctx.session.id, { prompt: '改为读取 b.txt' }, 'steer');
        steered = true;
        return reply('Old query summary');
      }
      if (steered) {
        assert.ok(request.tools.some((tool) => tool.name === 'read_file'));
        if (turns === 6)
          return {
            ...reply(),
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'new-read', name: 'read_file', arguments: { path: 'b.txt' } }],
          };
        return reply('New question answered');
      }
      return {
        ...reply(),
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'old-' + turns, name: 'read_file', arguments: { path: 'a.txt' } }],
      };
    },
  });
  await writeFile(path.join(ctx.root, 'a.txt'), 'old');
  await writeFile(path.join(ctx.root, 'b.txt'), 'new');
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: '读取 a.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'New question answered');
  assert.ok(
    ctx.events.some(
      (event) =>
        event.type === 'tool.started' && (event.data.call as { id: string }).id === 'new-read',
    ),
  );
});

test('agent executes tools, returns results to provider and persists history across reopen', async (t) => {
  let turn = 0;
  const provider: Provider = {
    async complete(request: ModelRequest) {
      // Read, then edit: a change to a file this run has not read is refused, so the flow that reaches a
      // *successful* mutation is exactly this one. The round count below follows it.
      if (turn++ === 0)
        return {
          ...reply('Reading'),
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.txt' } }],
        };
      if (turn === 2)
        return {
          ...reply('Editing'),
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'edit-1',
              name: 'edit_file',
              arguments: { path: 'a.txt', old_text: 'bad', new_text: 'good' },
            },
          ],
        };
      assert.ok(
        request.messages.some((m) => m.role === 'tool' && m.toolCallId === 'edit-1' && !m.isError),
      );
      return reply('Fixed');
    },
  };
  const { root, store, session, agent, events } = await fixture(t, provider);
  await writeFile(path.join(root, 'a.txt'), 'bad');
  const result = await agent.run({ sessionId: session.id, prompt: 'Fix a.txt' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Fixed');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'good');
  assert.ok(events.some((e) => e.type === 'tool.finished'));
  const starts = events.filter((e) => e.type === 'message.started');
  const ends = events.filter((e) => e.type === 'message.finished');
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.notEqual(starts[0]!.data.messageId, starts[1]!.data.messageId);
  assert.equal(ends[0]!.data.messageId, starts[0]!.data.messageId);
  assert.equal((ends[0]!.data.message as { toolCalls: unknown[] }).toolCalls.length, 1);
  const reopened = new SessionStore(path.join(root, 'sessions.sqlite'));
  const reopenedMessages = reopened.messages(session.id);
  assert.equal(typedUserMessages(reopenedMessages).length, 1);
  assert.equal(reopenedMessages.at(-1)?.role, 'assistant');
  reopened.close();
  assert.equal(store.get(session.id).activeRun, null);
});

test('tool errors go back to model and do not end the loop', async (t) => {
  let step = 0;
  const provider: Provider = {
    async complete(request) {
      if (step++ === 0)
        return {
          ...reply(),
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'bad', name: 'missing_tool', arguments: {} }],
        };
      assert.ok(request.messages.some((m) => m.role === 'tool' && m.isError));
      return reply('Unable to use that tool');
    },
  };
  const { session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Try' })).status, 'completed');
});

test('token truncation never executes returned tool calls', async (t) => {
  const provider: Provider = {
    async complete() {
      return {
        ...reply(),
        finishReason: 'length',
        toolCalls: [
          { id: 'write', name: 'write_file', arguments: { path: 'bad.txt', content: 'bad' } },
        ],
      };
    },
  };
  const { root, session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Write' })).status, 'limited');
  await assert.rejects(readFile(path.join(root, 'bad.txt')), { code: 'ENOENT' });
});

test('abort propagates to provider and session is unlocked', async (t) => {
  const provider: Provider = {
    async complete({ signal }) {
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  };
  const { session, agent, store } = await fixture(t, provider);
  const controller = new AbortController();
  const running = agent.run({ sessionId: session.id, prompt: 'Wait', signal: controller.signal });
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelReason, undefined);
  assert.equal(
    store.events(session.id).findLast((event) => event.type === 'run.finished')?.data.cancelReason,
    undefined,
  );
  assert.equal(store.get(session.id).activeRun, null);
});

test('concurrent run is rejected without corrupting the first run', async (t) => {
  let finish!: (response: ModelResponse) => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const provider: Provider = {
    complete: () =>
      new Promise((resolve) => {
        finish = resolve;
        enter();
      }),
  };
  const { session, agent, store } = await fixture(t, provider);
  const first = agent.run({ sessionId: session.id, prompt: 'one' });
  await assert.rejects(agent.run({ sessionId: session.id, prompt: 'two' }), /already running/i);
  await entered;
  finish(reply());
  assert.equal((await first).status, 'completed');
  assert.deepEqual(
    typedUserMessages(store.messages(session.id)).map((message) => message.content),
    ['one'],
  );
});

test('cancelled approval resolves every pending call without side effects', async (t) => {
  const provider: Provider = {
    async complete() {
      return {
        ...reply(),
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'a', name: 'write_file', arguments: { path: 'a.txt', content: 'bad' } },
          { id: 'b', name: 'write_file', arguments: { path: 'b.txt', content: 'bad' } },
        ],
      };
    },
  };
  const controller = new AbortController();
  const { session, agent, store, root } = await fixture(t, provider, {
    approve: async () => {
      controller.abort();
      return false;
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'write',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(store.messages(session.id).filter((m) => m.role === 'tool').length, 2);
  await assert.rejects(readFile(path.join(root, 'a.txt')), { code: 'ENOENT' });
});

test('oversized active context fails before requesting the provider', async (t) => {
  const provider: Provider = {
    async complete() {
      assert.fail('must not request oversized context');
    },
  };
  const { session, agent } = await fixture(t, provider, { maxContextChars: 1000 });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'x'.repeat(2000) })).status,
    'limited',
  );
});

test('a turn truncated at the output limit does not execute its tool calls', async (t) => {
  /**
   * The bound that stops a turn before its tool calls run is the *output* limit, not a spend: a response
   * that hit its cap is a partial answer by construction, and executing the calls inside it would act on a
   * decision the model never finished making.
   */
  const provider: Provider = {
    async complete() {
      return {
        text: '',
        toolCalls: [
          {
            id: 'truncated',
            name: 'write_file',
            arguments: { path: 'truncated.txt', content: 'x' },
          },
        ],
        finishReason: 'length',
        usage: { inputTokens: 10_000, outputTokens: 10 },
      };
    },
  };
  const { root, session, agent } = await fixture(t, provider, { maxOutputTokens: 512 });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'write' })).status, 'limited');
  await assert.rejects(readFile(path.join(root, 'truncated.txt')), { code: 'ENOENT' });
});

test('request timeout is a failed run and releases the session lock', async (t) => {
  const provider: Provider = {
    async complete({ signal }) {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Test request never timed out')), 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const { session, agent, store } = await fixture(t, provider, { requestTimeoutMs: 20 });
  const result = await agent.run({ sessionId: session.id, prompt: 'wait' });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /timeout|timed out/i);
  assert.equal(store.get(session.id).activeRun, null);
});

test('event listener failures are isolated from run execution and finalization', async (t) => {
  let eventCount = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        return reply('done');
      },
    },
    {
      onEvent: () => {
        if (eventCount++ === 0) throw new Error('listener failed');
        return Promise.reject(new Error('async listener failed'));
      },
    },
  );
  let closed = 0;
  const close = ctx.tools.close.bind(ctx.tools);
  ctx.tools.close = async () => {
    closed++;
    await close();
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'completed');
  assert.equal(closed, 1);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
  assert.throws(
    () => ctx.agent.enqueue(ctx.session.id, { prompt: 'late' }, 'steer'),
    /not running/i,
  );
});

test('resolvePending failure cannot bypass tool cleanup or leave an active run', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      throw new Error('provider failed');
    },
  });
  let closed = 0;
  const close = ctx.tools.close.bind(ctx.tools);
  ctx.tools.close = async () => {
    closed++;
    await close();
  };
  ctx.store.resolvePending = () => {
    throw new Error('resolve failed');
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'failed');
  assert.match(result.error!, /resolve pending tool calls/i);
  assert.equal(closed, 1);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('tool cleanup failure is persisted as failed and releases the session lock', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  ctx.tools.close = async () => {
    throw new Error('close failed');
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'failed');
  assert.match(result.error!, /tool resource cleanup failed/i);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('finishRun failure is reflected and retried to release the session lock', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  const finishRun = ctx.store.finishRun.bind(ctx.store);
  let attempts = 0;
  ctx.store.finishRun = (result) => {
    attempts++;
    if (attempts === 1) throw new Error('transient finish failure');
    finishRun(result);
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(attempts, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /persist run finalization/i);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('a retry that also fails still returns the run instead of rejecting it', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  let attempts = 0;
  ctx.store.finishRun = () => {
    attempts++;
    throw new Error('persistent finish failure');
  };

  // The fallback repeats the same write. Rejecting out of the run's `finally` would hand the caller an
  // exception instead of a result, and no `run.finished` would ever be emitted for the run.
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(attempts, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /persist run finalization/i);
});

test('task runs complete only after persisted acceptance passes', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  await writeFile(path.join(ctx.root, 'result.txt'), 'verified');
  const task = ctx.store.createTask(ctx.session.id, {
    title: 'verify output',
    acceptance: [
      {
        description: 'result file is verified',
        met: false,
        check: { id: 'result', kind: 'file-exact', path: 'result.txt', expected: 'verified' },
      },
    ],
  });
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: task.id,
  });
  assert.equal(result.status, 'completed');
  assert.equal((result.acceptance as { passed: boolean }).passed, true);
  const persisted = ctx.store.getTask(ctx.session.id, task.id);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.acceptance[0]?.met, true);
  assert.equal(persisted.verification?.passed, true);
});

test('a task with no acceptance criteria does not complete vacuously after a run', async (t) => {
  /**
   * The reversal of the behaviour this test used to pin.
   *
   * "Every criterion of none holds" made an empty definition a pass, so a task nobody had said what done meant
   * for was reported as verified by the model's own closing sentence. It is now the definition-level stop
   * `empty-acceptance`, and the task stays open until a criterion states what done means.
   */
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  const task = ctx.store.createTask(ctx.session.id, { title: 'no criteria' });
  assert.deepEqual(task.acceptance, []);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: task.id,
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
  assert.match(String(result.error), /no acceptance criteria/i);
  assert.equal(ctx.store.getTask(ctx.session.id, task.id).status, 'needs_review');
});

test('failed or non-executable task acceptance requires review', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('claimed done');
    },
  });
  const failed = ctx.store.createTask(ctx.session.id, {
    title: 'missing output',
    acceptance: [
      {
        description: 'output exists',
        met: false,
        check: { id: 'missing', kind: 'file-contains', path: 'missing.txt', expected: 'done' },
      },
    ],
  });
  const failedResult = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: failed.id,
  });
  assert.equal(failedResult.status, 'needs_review');
  assert.equal(ctx.store.getTask(ctx.session.id, failed.id).status, 'needs_review');

  const manual = ctx.store.createTask(ctx.session.id, {
    title: 'manual review',
    acceptance: [{ description: 'human confirms appearance', met: false }],
  });
  const manualResult = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: manual.id,
  });
  assert.equal(manualResult.status, 'needs_review');
  assert.match(manualResult.error!, /review/i);
});

test('text-only connections reject new and historical images before provider requests', async (t) => {
  let requests = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        requests++;
        return reply();
      },
    },
    { supportsVision: false },
  );
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  await assert.rejects(
    ctx.agent.run({ sessionId: ctx.session.id, prompt: 'inspect', images: [image] }),
    /图片/,
  );
  assert.equal(ctx.store.messages(ctx.session.id).length, 0);
  ctx.store.append(ctx.session.id, { role: 'user', content: 'old image', images: [image] });
  await assert.rejects(ctx.agent.run({ sessionId: ctx.session.id, prompt: 'continue' }), /图片/);
  assert.equal(requests, 0);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});
for (const supportsVision of [false, undefined])
  test(`tool pictures reach a model only if it accepts images (supportsVision: ${supportsVision})`, async (t) => {
    const pixel = {
      mimeType: 'image/png' as const,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    };
    let sent: Message[] = [];
    let turn = 0;
    const ctx = await fixture(
      t,
      {
        async complete(request) {
          if (turn++ === 0)
            return {
              ...reply(''),
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'picture', name: 'picture_tool', arguments: {} }],
            };
          sent = request.messages;
          return reply();
        },
      },
      { supportsVision },
    );
    ctx.tools.register({
      name: 'picture_tool',
      description: 'Returns a picture',
      inputSchema: { type: 'object' },
      async execute() {
        return { isError: false, content: 'one picture', images: [pixel] };
      },
    });
    assert.equal(
      (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'look' })).status,
      'completed',
    );
    const result = sent.find((message) => message.role === 'tool');
    assert.equal(result?.role, 'tool');
    if (result?.role !== 'tool') return;
    if (supportsVision === false) {
      assert.equal(result.images, undefined);
      assert.match(
        result.content,
        /^one picture\n\[1 image\(s\) not sent: the current model does not accept images/,
      );
    } else {
      assert.equal(result.images?.length, 1);
      assert.equal(result.content, 'one picture');
    }
    // The transcript keeps the picture, so switching back to a vision model shows it again.
    const stored = ctx.store.messages(ctx.session.id).find((message) => message.role === 'tool');
    assert.equal(stored?.role === 'tool' ? stored.images?.length : undefined, 1);
  });
test('a picture an earlier vision model saw is not sent after switching to a text-only one', async (t) => {
  const pixel = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  let sent: Message[] = [];
  const ctx = await fixture(
    t,
    {
      async complete(request) {
        sent = request.messages;
        return reply();
      },
    },
    { supportsVision: false },
  );
  ctx.store.append(ctx.session.id, { role: 'user', content: 'show it' });
  ctx.store.append(ctx.session.id, {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'old', name: 'read_image', arguments: { path: 'a.png' } }],
  });
  ctx.store.append(ctx.session.id, {
    role: 'tool',
    toolCallId: 'old',
    content: 'Image a.png attached.',
    isError: false,
    images: [pixel],
  });
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'continue' })).status,
    'completed',
  );
  const result = sent.find((message) => message.role === 'tool');
  assert.equal(result?.role === 'tool' ? result.images : 'missing', undefined);
  assert.match(result?.content ?? '', /not sent: the current model does not accept images/);
});
test('each user turn persists the selected model identity without changing provider content', async (t) => {
  const identity = { model: 'model-a', protocol: 'openai', connectionId: 'connection-a' };
  const ctx = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    { modelInfo: identity },
  );
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' })).status,
    'completed',
  );
  const first = typedUserMessages(ctx.store.messages(ctx.session.id))[0];
  assert.ok(first?.role === 'user');
  assert.deepEqual(first.modelInfo, identity);
  const second = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => false,
    provider: {
      async complete() {
        return reply();
      },
    },
    modelInfo: { ...identity, model: 'model-b' },
  });
  await second.run({ sessionId: ctx.session.id, prompt: 'continue' });
  const users = typedUserMessages(ctx.store.messages(ctx.session.id));
  assert.deepEqual(
    users.map((m) => m.modelInfo?.model),
    ['model-a', 'model-b'],
  );
});

for (const firstMutation of ['file', 'shell'] as const) {
  test(`implementation runs continue beyond twenty rounds and cumulative token budget (${firstMutation})`, async (t) => {
    let rounds = 0;
    const { root, session, agent, store } = await fixture(t, {
      async complete(request) {
        assert.ok(Number.isFinite(request.maxOutputTokens));
        rounds++;
        await writeFile(path.join(root, 'a.txt'), 'new content ' + rounds);
        return {
          ...reply(rounds > 24 ? 'Completed long task' : 'Reading'),
          usage: { inputTokens: 12000, outputTokens: 100 },
          ...(rounds <= 24
            ? {
                finishReason: 'tool_calls' as const,
                toolCalls: [
                  rounds === 1
                    ? firstMutation === 'file'
                      ? {
                          id: 'write-source',
                          name: 'write_file',
                          arguments: { path: 'implemented.txt', content: 'implemented' },
                        }
                      : {
                          id: 'write-source',
                          name: 'run_command',
                          arguments: { command: 'node implement.cjs' },
                        }
                    : { id: 'read-' + rounds, name: 'read_file', arguments: { path: 'a.txt' } },
                ],
              }
            : {}),
        };
      },
    });
    await writeFile(path.join(root, 'a.txt'), 'content');
    await writeFile(
      path.join(root, 'implement.cjs'),
      "require('node:fs').writeFileSync('implemented.txt','implemented')",
    );
    const result = await agent.run({ sessionId: session.id, prompt: 'Complete a long task' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(rounds, 25);
    assert.ok(result.usage.inputTokens > 100000);
    assert.equal(store.get(session.id).activeRun, null);
  });
}

test('a retried task receives persisted attempt evidence and a no-replay recovery instruction', async (t) => {
  let calls = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      calls++;
      if (calls === 1) throw new Error('Simulated provider interruption');
      assert.match(request.system, /Previous task attempt/);
      assert.match(request.system, /inspect.*before.*repeat/i);
      assert.match(request.system, /Simulated provider interruption/);
      return reply('Recovered');
    },
  });
  // A criterion the recovered run can satisfy: an empty definition is no longer a vacuous pass, and this test is
  // about the recovery instruction the resumed attempt is given, not about what "done" means.
  await writeFile(path.join(ctx.root, 'marker.txt'), 'ok');
  const task = ctx.store.createTask(ctx.session.id, {
    title: 'Long task',
    acceptance: [
      {
        description: 'marker file matches',
        met: false,
        check: { id: 'marker', kind: 'file-contains', path: 'marker.txt', expected: 'ok' },
      },
    ],
  });
  const first = await ctx.agent.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Do work',
  });
  assert.equal(first.status, 'failed');
  const resumed = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => true,
    provider: {
      async complete(request) {
        assert.match(request.system, /Previous task attempt/);
        assert.match(request.system, /inspect.*before.*repeat/i);
        assert.match(request.system, /Simulated provider interruption/);
        return reply('Recovered');
      },
    },
  });
  const second = await resumed.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Continue safely',
  });
  assert.equal(second.status, 'completed');
});

test('task delivery stays in review until the declared artifact exists and verifies', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('Delivered report.txt');
    },
  });
  const task = ctx.store.createTask(ctx.session.id, {
    title: 'Deliver report',
    acceptance: [
      {
        description: 'Report is delivered',
        met: false,
        check: {
          id: 'report',
          kind: 'file-delivery',
          path: 'report.txt',
          format: 'text',
          minBytes: 5,
        },
      },
    ],
  });
  const first = await ctx.agent.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Deliver',
  });
  assert.equal(first.status, 'needs_review');
  await writeFile(path.join(ctx.root, 'report.txt'), 'Verified delivery content');
  const resumed = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => true,
    provider: {
      async complete() {
        return reply('Delivered after verification');
      },
    },
  });
  const second = await resumed.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Verify delivery',
  });
  assert.equal(second.status, 'completed');
  assert.match(second.acceptance?.checks[0]?.detail ?? '', /sha256/);
});

test('output truncation reports token breakdown and live model phase without leaking reasoning', async (t) => {
  const provider: Provider = {
    async complete(request) {
      request.onProgress?.({
        phase: 'reasoning',
        reasoningChars: 14,
        toolArgumentChars: 0,
        visibleChars: 0,
      });
      return {
        ...reply(''),
        finishReason: 'length',
        usage: { inputTokens: 9, outputTokens: 100 },
        outputDiagnostics: {
          reasoningTokens: 95,
          reasoningChars: 14,
          toolArgumentChars: 0,
          visibleChars: 0,
        },
      };
    },
  };
  const { session, agent, events } = await fixture(t, provider, { maxOutputTokens: 100 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Work' });
  assert.equal(result.status, 'limited');
  assert.match(result.error!, /100\/100 output tokens/);
  assert.match(result.error!, /95 reasoning tokens/);
  assert.match(result.error!, /14 reasoning characters/);
  assert.doesNotMatch(result.error!, /private thought/);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'statistics.updated' &&
        (event.data.activity as { phase?: string } | null)?.phase === 'reasoning',
    ),
  );
});

// ---- merged from run-queue.test.ts ----

const reply2 = (text = 'done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
});
async function setup(
  t: test.TestContext,
  provider: Provider,
  approve: Approver = async () => true,
) {
  const { root, store } = await storeFixture(t, 'yuantu-queue-', 'session.sqlite');
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    approve,
    tools,
    onEvent: (e) => events.push(e),
  });
  return { root, store, session, agent, events, tools };
}
test('steer interrupts pending approval and skips remaining stale calls before requesting the model', async (t) => {
  let awaiting!: () => void;
  const waiting = new Promise<void>((resolve) => (awaiting = resolve));
  let requests = 0;
  const { root, store, session, agent } = await setup(
    t,
    {
      async complete(request) {
        if (requests++ === 0)
          return {
            ...reply2(),
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'first', name: 'write_file', arguments: { path: 'one.txt', content: 'bad' } },
              { id: 'second', name: 'write_file', arguments: { path: 'two.txt', content: 'bad' } },
            ],
          };
        assert.equal(request.messages.at(-1)?.content, 'Do not write; just explain.');
        assert.equal(request.messages.filter((m) => m.role === 'tool').length, 2);
        return reply2('Explained only');
      },
    },
    async (_approval, signal) => {
      awaiting();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(false), { once: true }),
      );
    },
  );
  const run = agent.run({ sessionId: session.id, prompt: 'Write files' });
  await waiting;
  agent.enqueue(session.id, { prompt: 'Do not write; just explain.' }, 'steer');
  const result = await run;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Explained only');
  await assert.rejects(readFile(path.join(root, 'one.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'two.txt')), { code: 'ENOENT' });
  assert.equal(typedUserMessages(store.messages(session.id)).length, 2);
});
test('steering wins an approval race even when the approver returns allow', async (t) => {
  let calls = 0;
  const { agent, session, root } = await setup(
    t,
    {
      async complete() {
        return calls++ === 0
          ? {
              ...reply2(),
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'w', name: 'write_file', arguments: { path: 'race.txt', content: 'bad' } },
              ],
            }
          : reply2();
      },
    },
    async () => {
      agent.enqueue(session.id, { prompt: 'Do not write' }, 'steer');
      return true;
    },
  );
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Write' })).status, 'completed');
  await assert.rejects(readFile(path.join(root, 'race.txt')), { code: 'ENOENT' });
});

test('steer lets a running tool finish and skips the next stale tool', async (t) => {
  let release!: () => void;
  const runningTool = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const readyTool = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let requests = 0,
    executed = 0;
  const { agent, session, tools, store } = await setup(t, {
    async complete(request) {
      if (requests++ === 0)
        return {
          ...reply2(),
          finishReason: 'tool_calls',
          toolCalls: ['first', 'second'].map((id) => ({ id, name: 'held_tool', arguments: {} })),
        };
      assert.equal(request.messages.at(-1)?.content, 'Change direction');
      return reply2();
    },
  });
  tools.register({
    name: 'held_tool',
    description: 'A tool in progress',
    inputSchema: { type: 'object' },
    async execute() {
      executed++;
      ready();
      await runningTool;
      return { isError: false, content: 'Actual tool completed' };
    },
  });
  const run = agent.run({ sessionId: session.id, prompt: 'Run two tools' });
  await readyTool;
  assert.throws(() => agent.enqueue('other-session', { prompt: 'Wrong' }, 'steer'), /not running/);
  agent.enqueue(session.id, { prompt: 'Change direction' }, 'steer');
  release();
  assert.equal((await run).status, 'completed');
  assert.equal(executed, 1);
  const results = store.messages(session.id).filter((m) => m.role === 'tool');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.isError, false);
  assert.equal(results[1]!.isError, true);
});

test('follow-ups execute in FIFO order after the current turn and are durable once consumed', async (t) => {
  let release!: (v: ModelResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let turns = 0;
  const { agent, session, store } = await setup(t, {
    async complete(request) {
      if (turns++ === 0) {
        started();
        return new Promise<ModelResponse>((r) => (release = r));
      }
      return reply2('answer ' + request.messages.at(-1)?.content);
    },
  });
  const running = agent.run({ sessionId: session.id, prompt: 'first' });
  await ready;
  agent.enqueue(session.id, { prompt: 'second' }, 'follow-up');
  agent.enqueue(session.id, { prompt: 'third' }, 'follow-up');
  assert.equal(agent.getQueue(session.id).length, 2);
  release(reply2('answer first'));
  assert.equal((await running).text, 'answer third');
  assert.deepEqual(
    typedUserMessages(store.messages(session.id)).map((message) => message.content),
    ['first', 'second', 'third'],
  );
  assert.equal(agent.getQueue(session.id).length, 0);
  assert.throws(() => agent.enqueue(session.id, { prompt: 'late' }, 'steer'), /not running/);
});
test('cancel clears unconsumed inputs and does not replay them into history', async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const { agent, session, store } = await setup(t, {
    complete: ({ signal }) => {
      started();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  const aborter = new AbortController();
  const running = agent.run({ sessionId: session.id, prompt: 'first', signal: aborter.signal });
  await ready;
  agent.enqueue(session.id, { prompt: 'never execute' }, 'follow-up');
  aborter.abort();
  assert.equal((await running).status, 'cancelled');
  assert.equal(agent.getQueue(session.id).length, 0);
  assert.equal(typedUserMessages(store.messages(session.id)).length, 1);
});

test('queued image metadata does not duplicate base64 data into queue events', async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let release!: (v: ModelResponse) => void;
  const { agent, session, events } = await setup(t, {
    complete: () => {
      started();
      return new Promise((r) => (release = r));
    },
  });
  const running = agent.run({ sessionId: session.id, prompt: 'first' });
  await ready;
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  agent.enqueue(session.id, { prompt: 'image later', images: [image] }, 'follow-up');
  assert.doesNotMatch(JSON.stringify(events.filter((e) => e.type === 'input.queued')), /iVBOR/);
  assert.equal(agent.getQueue(session.id)[0]!.imageCount, 1);
  agent.clearQueue(session.id);
  release(reply2());
  await running;
});

test('queued messages retain submission time when consumed later', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-22T02:00:00.000Z') });
  const queue = new RunQueue();
  queue.add({ prompt: 'later' }, 'follow-up');
  t.mock.timers.setTime(new Date('2026-09-22T02:10:00.000Z').getTime());
  assert.equal(queue.take('follow-up')?.createdAt, '2026-09-22T02:00:00.000Z');
});

// ---- merged from statistics.test.ts ----

test('statistics aggregate usage without inventing missing cache information', () => {
  const stats = emptyStatistics();
  addUsage(stats, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 });
  assert.equal(stats.cachedInputTokens, 80);
  assert.equal(stats.cacheKnown, true);
  // A cache write is a part of the reported input total, kept separately so "is the prompt cache paying for
  // itself?" has an answer: a write is billed differently from a read and is what makes the next read cheap.
  addUsage(stats, {
    inputTokens: 200,
    outputTokens: 5,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 150,
  });
  assert.equal(stats.cacheWriteInputTokens, 150);
  assert.equal(stats.inputTokens, 300);
  // A provider that does not report cache writes at all leaves the total at what it did report.
  addUsage(stats, { inputTokens: 50, outputTokens: 10 });
  assert.equal(stats.inputTokens, 350);
  assert.equal(stats.outputTokens, 35);
  assert.equal(stats.cacheWriteInputTokens, 150, 'an unreported write is not a zero');
  assert.equal(stats.cacheKnown, false);
});

test('statistics combine completed runs without mutating their stored values', () => {
  const first = {
    ...emptyStatistics(),
    turns: 1,
    steps: 2,
    inputTokens: 100,
    outputTokens: 20,
    modelMs: 2000,
    toolMs: 500,
    firstTokenMs: 300,
    firstTokenCount: 1,
    decodeMs: 1200,
    decodeTokens: 20,
  };
  const combined = addStatistics(first, {
    ...emptyStatistics(),
    turns: 1,
    steps: 1,
    modelMs: 1000,
    firstTokenMs: 100,
    firstTokenCount: 1,
    decodeMs: 400,
    decodeTokens: 5,
    cachedInputTokens: 30,
  });
  assert.equal(combined.modelMs, 3000);
  assert.equal(combined.toolMs, 500);
  assert.equal(combined.firstTokenMs / combined.firstTokenCount, 200);
  // The output speed is output over the *decode* half of a step, so both halves have to add up: a total that
  // summed one and not the other would report a throughput no step ever had.
  assert.equal(combined.decodeTokens / (combined.decodeMs / 1000), 25 / 1.6);
  assert.equal(combined.turns, 2);
  assert.equal(combined.steps, 3);
  assert.equal(first.modelMs, 2000);
  assert.equal(first.steps, 2);
});

test('a run recorded before the boundary and decode fields still sums', () => {
  // The log is read by builds that did not write these fields: the ones that predate them contribute zero
  // rather than `NaN`, which is what keeps a session's totals finite after an upgrade.
  const legacy = { ...emptyStatistics() } as Record<string, unknown>;
  delete legacy.turns;
  delete legacy.steps;
  delete legacy.decodeMs;
  delete legacy.decodeTokens;
  const combined = addStatistics(emptyStatistics(), legacy as never);
  assert.equal(combined.turns, 0);
  assert.equal(combined.steps, 0);
  assert.equal(combined.decodeMs, 0);
  assert.equal(combined.decodeTokens, 0);
});

// ---- merged from errors.test.ts ----

test('diagnostics keep numeric token limits while redacting credential values', () => {
  const message = '100/100 output tokens; key is secret-value';
  const env = {
    YUANTU_MAX_OUTPUT_TOKENS: '100',
    YUANTU_API_KEY: 'secret-value',
    GITHUB_TOKEN: 'github-secret',
  };
  assert.equal(
    redactSecrets(message + '; github-secret', env),
    '100/100 output tokens; key is [redacted]; [redacted]',
  );
});

test('the transcript cache holds a full fan-out and the residents beside their parent', async () => {
  // An LRU smaller than the set of sessions read in turn misses on every read; see `LOG_CACHE_ENTRIES`.
  const { LOG_CACHE_ENTRIES } = await import('../packages/storage/session-schema.ts');
  const { SUBAGENT_CEILINGS } = await import('../packages/core/subagents.ts');
  const { RESIDENCY_DEFAULTS } = await import('../packages/core/residency.ts');
  assert.ok(
    LOG_CACHE_ENTRIES >= 1 + SUBAGENT_CEILINGS.maxConcurrency + RESIDENCY_DEFAULTS.maxResident,
  );
});
