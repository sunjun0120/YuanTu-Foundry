import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import { createRunCompletion } from '../packages/core/run-completion.ts';
import type { ModelRequest, Plan, Provider, ToolCall } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

function scripted(
  turns: (string | Omit<ToolCall, 'id'>[])[],
  requests: ModelRequest[] = [],
): Provider {
  let index = 0;
  return {
    async complete(request) {
      requests.push(request);
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      return {
        text: typeof turn === 'string' ? turn : '',
        toolCalls:
          typeof turn === 'string' ? [] : turn.map((call, n) => ({ ...call, id: `${index}-${n}` })),
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: typeof turn === 'string' ? 'stop' : 'tool_calls',
      };
    },
  };
}

const check = {
  command: process.execPath,
  args: ['-e', "if(require('node:fs').readFileSync('out.txt','utf8')!=='fixed')process.exit(1)"],
};
const verify = { name: 'verify_work', arguments: { commands: [check], inputs: ['out.txt'] } };
const write = (content: string) => ({
  name: 'write_file',
  arguments: { path: 'out.txt', content },
});

test('automatic verification keeps tool declarations stable when checks are registered', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [
        [{ name: 'completion_scope', arguments: { paths: ['out.txt'] } }],
        [verify, write('fixed')],
        'Done',
      ],
      requests,
    ),
  }).run({ sessionId: session.id, prompt: 'Fix the output', autoVerify: true });
  assert.equal(result.completion?.state, 'verified', JSON.stringify(result));
  assert.ok(requests[0]!.tools.some((tool) => tool.name === 'completion_step'));
  assert.ok(requests[0]!.tools.some((tool) => tool.name === 'completion_scope'));
  for (const request of requests) assert.deepEqual(request.tools, requests[0]!.tools);
  const early = store.messages(session.id).find((message) => message.role === 'tool');
  assert.ok(early?.role === 'tool' && early.isError);
  assert.match(early.content, /no verification contract/i);
  assert.deepEqual(store.completionCurrent(session.id)?.affectedPaths, ['out.txt']);
});

test('predeclared completion tools refuse missing contracts and read-only calls without recording changes', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const tools = new ToolRegistry();
  const signal = new AbortController().signal;
  const completion = createRunCompletion({
    store,
    sessionId: session.id,
    runId: 'guard-test',
    emit() {},
    tools,
    readOnly: false,
    planPhase: false,
    task: undefined,
    taskAttempt: undefined,
    workspace: root,
    signal,
    baselines: {},
    approve: async () => true,
    request: {
      completion: undefined,
      resumeCompletionId: undefined,
      completionInputs: undefined,
      approvedPlan: undefined,
      repairPolicy: undefined,
    },
  });
  completion.registerTools(true);
  const calls: ToolCall[] = [
    { id: 'step', name: 'completion_step', arguments: { id: 's1', status: 'completed' } },
    { id: 'scope', name: 'completion_scope', arguments: { paths: ['source.txt'] } },
  ];
  for (const call of calls) {
    const response = await tools.execute(call, { signal, approve: async () => true });
    assert.equal(response.isError, true);
    assert.match(response.content, /no verification contract/i);
  }
  assert.equal(store.newestPayload(session.id, 'completion.updated'), undefined);
  completion.configureAutomatic({
    version: 1,
    objective: 'Inspect output',
    steps: [{ id: 's1', description: 'Inspect', status: 'pending' }],
    constraints: [],
    acceptance: [],
    inputs: [],
  });
  const seq = store.lastSeq(session.id);
  for (const call of calls) {
    const response = await tools.execute(call, {
      signal,
      approve: async () => true,
      readOnly: true,
    });
    assert.equal(response.isError, true);
    assert.match(response.content, /read-only/i);
  }
  assert.equal(store.lastSeq(session.id), seq);
  assert.equal(completion.state.steps[0]!.status, 'pending');
  assert.deepEqual(completion.state.affectedPaths, []);
});

test('diagnostic commands and scratch probes do not demand project verification', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await mkdir(path.join(root, '.scratch'));
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [
        [
          {
            name: 'write_file',
            arguments: { path: '.scratch/probe.cjs', content: "console.log('diagnosis')" },
          },
        ],
        [{ name: 'run_command', arguments: { command: 'node .scratch/probe.cjs' } }],
        'Here is the diagnosis',
      ],
      requests,
    ),
  }).run({ sessionId: session.id, prompt: 'Why is the project slow?', autoVerify: true });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion, undefined);
  assert.equal(requests.length, 3, 'diagnosis must not acquire a verification reminder');
  const answer = store
    .messages(session.id)
    .find((message) => message.role === 'assistant' && message.content === 'Here is the diagnosis');
  assert.ok(answer?.role === 'assistant');
  assert.equal(answer.provisional, undefined);
});

test('shell-only source changes during a question still require verification', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(
    path.join(root, 'probe.cjs'),
    "require('node:fs').writeFileSync('source.txt','changed')",
  );
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([
      [{ name: 'run_command', arguments: { command: 'node probe.cjs' } }],
      'Answer',
    ]),
  }).run({ sessionId: session.id, prompt: 'Explain this project', autoVerify: true });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.reason, 'missing-verification');
});

test('an incomplete workspace observation stops honestly without verification errands', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(path.join(root, 'large.bin'), '');
  await truncate(path.join(root, 'large.bin'), 64 * 1024 * 1024 + 1);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [[{ name: 'run_command', arguments: { command: 'node --version' } }], 'Diagnostic answer'],
      requests,
    ),
  }).run({ sessionId: session.id, prompt: 'What version is installed?', autoVerify: true });
  assert.equal(requests.length, 2);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.reason, 'environment-error');
  assert.match(result.error!, /change detection was unavailable/);
  assert.equal(result.completion?.verificationRound, 0);
  assert.ok(
    !store
      .messages(session.id)
      .some(
        (message) =>
          message.role === 'user' && message.content.includes('no verification checks yet'),
      ),
  );
});

test('a completed diagnostic answer survives cancellation during final observation', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const controller = new AbortController();
  let requests = 0;
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: {
      async complete() {
        if (++requests === 1)
          return {
            text: '',
            toolCalls: [
              { id: 'version', name: 'run_command', arguments: { command: 'node --version' } },
            ],
            finishReason: 'tool_calls',
            usage: { inputTokens: 10, outputTokens: 1 },
          };
        controller.abort(new Error('cancel after terminal response'));
        return {
          text: 'Completed diagnosis',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 1 },
        };
      },
    },
  }).run({
    sessionId: session.id,
    prompt: 'Explain the installed version',
    autoVerify: true,
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, 'Completed diagnosis');
  const answer = store
    .messages(session.id)
    .find((message) => message.role === 'assistant' && message.content === 'Completed diagnosis');
  assert.ok(answer?.role === 'assistant');
  assert.equal(answer.provisional, undefined);
});

test('ordinary requests run agent-selected checks and repair failures in the same run', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [
        [verify, write('wrong')],
        'Done',
        [{ name: 'read_file', arguments: { path: 'out.txt' } }],
        [
          {
            name: 'edit_file',
            arguments: { path: 'out.txt', old_text: 'wrong', new_text: 'fixed' },
          },
        ],
        'Fixed',
      ],
      requests,
    ),
  }).run({ sessionId: session.id, prompt: 'Fix the output', autoVerify: true });
  assert.equal(
    result.status,
    'completed',
    JSON.stringify({
      error: result.error,
      completion: result.completion,
      acceptance: result.acceptance,
      tools: store.messages(session.id).filter((message) => message.role === 'tool'),
    }),
  );
  assert.equal(result.completion?.state, 'verified');
  assert.equal(result.completion?.repairRounds, 1);
  assert.equal(result.completion?.verificationRound, 2);
  assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'fixed');
  assert.match(JSON.stringify(requests[2]?.messages), /assertion-failed/);
  assert.equal(store.events(session.id).filter((event) => event.type === 'run.finished').length, 1);
  assert.ok(store.completionCurrent(session.id)?.summary.inputDigest);
  assert.equal(store.completionCurrent(session.id)?.source, 'automatic');
  assert.equal(store.completionCurrent(session.id)?.evidence?.checks[0]?.command?.exitCode, 0);
});

test('approved plans retain their steps and automatically execute selected checks', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const plan: Plan = {
    id: 'p1',
    sessionId: session.id,
    status: 'approved',
    title: 'Produce the output',
    summary: '',
    steps: [{ description: 'Write the correct output' }],
    hash: 'approved-hash',
    createdAt: '',
    updatedAt: '',
  };
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [
        [verify],
        [
          write('fixed'),
          { name: 'completion_step', arguments: { id: 'plan:p1:0', status: 'completed' } },
        ],
        'Done',
      ],
      requests,
    ),
  }).run({
    sessionId: session.id,
    prompt: 'Execute the approved plan',
    approvedPlan: plan,
    autoVerify: true,
  });
  assert.equal(result.completion?.state, 'verified', JSON.stringify(result));
  assert.equal(store.completionCurrent(session.id)?.planHash, 'approved-hash');
  assert.equal(
    store.completionCurrent(session.id)?.steps[0]?.description,
    'Write the correct output',
  );
  assert.ok(requests[1]?.tools.some((tool) => tool.name === 'completion_step'));
});

test('automatic verification monitors changed files beyond selected inputs through final cleanup', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(path.join(root, 'out.txt'), 'fixed');
  const hooks = new HookRegistry();
  hooks.register({
    stop: async () => {
      await writeFile(path.join(root, 'other.txt'), 'changed after checks');
    },
  });
  const tools = createTools(root, undefined, 'standalone', hooks);
  const result = await new Agent({
    store,
    tools,
    approve: async () => true,
    provider: scripted([
      [verify, { name: 'write_file', arguments: { path: 'other.txt', content: 'original' } }],
      'Done',
    ]),
  }).run({ sessionId: session.id, prompt: 'Produce the output', autoVerify: true });
  assert.equal(result.status, 'needs_review');
  assert.notEqual(result.completion?.state, 'verified');
});

test('grouped edits monitor each real file rather than the group display label', async (t) => {
  const { root, store, session } = await storeFixture(t);
  for (const file of ['out.txt', 'a.txt', 'b.txt']) await writeFile(path.join(root, file), 'fixed');
  const hooks = new HookRegistry();
  hooks.register({
    stop: async () => {
      await writeFile(path.join(root, 'b.txt'), 'changed after checks');
    },
  });
  const result = await new Agent({
    store,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    provider: scripted([
      [verify],
      ['a.txt', 'b.txt'].map((file) => ({ name: 'read_file', arguments: { path: file } })),
      [
        {
          name: 'batch_edit',
          arguments: {
            edits: ['a.txt', 'b.txt'].map((file) => ({
              path: file,
              old_text: 'fixed',
              new_text: 'edited',
            })),
          },
        },
      ],
      'Done',
    ]),
  }).run({ sessionId: session.id, prompt: 'Edit both files', autoVerify: true });
  assert.equal(result.status, 'needs_review');
  assert.notEqual(result.completion?.state, 'verified');
  assert.deepEqual(store.completionCurrent(session.id)?.affectedPaths.sort(), ['a.txt', 'b.txt']);
});

test('a command that writes files and exits nonzero still requires verification', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(
    path.join(root, 'partial.cjs'),
    "require('node:fs').writeFileSync('partial.txt','partial');process.exit(1)",
  );
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([
      [{ name: 'run_command', arguments: { command: 'node partial.cjs' } }],
      'Done',
    ]),
  }).run({ sessionId: session.id, prompt: 'Implement the change', autoVerify: true });
  assert.equal(await readFile(path.join(root, 'partial.txt'), 'utf8'), 'partial');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.reason, 'missing-verification');
});

for (const { exitCode, hook, targeted } of [
  { exitCode: 0, hook: 'none', targeted: true },
  { exitCode: 1, hook: 'none', targeted: true },
  { exitCode: 1, hook: 'observer-failure', targeted: true },
  { exitCode: 1, hook: 'feedback', targeted: true },
  { exitCode: 1, hook: 'finalize', targeted: true },
  { exitCode: 1, hook: 'block', targeted: true },
  { exitCode: 0, hook: 'invalid-images', targeted: true },
  { exitCode: 1, hook: 'feedback', targeted: false },
]) {
  test(`a validation that writes files requires verification after exit ${exitCode} (${hook}, targeted: ${targeted})`, async (t) => {
    const { root, store, session } = await storeFixture(t);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
    );
    await writeFile(
      path.join(root, 'partial.test.cjs'),
      `require('node:fs').writeFileSync('partial.txt','partial');process.exit(${exitCode})`,
    );
    const hooks = new HookRegistry();
    if (hook === 'observer-failure')
      hooks.register({
        afterTool: (call) => {
          if (call.name === 'run_validation') throw new Error('Observer failed after execution');
        },
      });
    if (hook === 'feedback')
      hooks.register({
        postExecute: (_execution, result) => ({
          action: 'replace-content',
          content: result.content + '\n\n[PostToolUse hook] Review the partial changes.',
        }),
      });
    if (hook === 'finalize')
      hooks.register({ finalizeContent: () => 'Validation output redacted by extension' });
    if (hook === 'block')
      hooks.register({ postExecute: () => ({ action: 'block', reason: 'Output withheld' }) });
    if (hook === 'invalid-images')
      hooks.register({
        postExecute: () => ({
          action: 'replace',
          result: {
            isError: false,
            content: 'Replacement output',
            images: [{ mimeType: 'image/png', data: 'not-an-image' }],
          },
        }),
      });
    const requests: ModelRequest[] = [];
    const result = await new Agent({
      store,
      tools: createTools(root, undefined, 'standalone', hooks),
      approve: async () => true,
      provider: scripted(
        [
          [
            {
              name: 'run_validation',
              arguments: { id: 'npm:test', ...(targeted ? { files: ['partial.test.cjs'] } : {}) },
            },
          ],
          'Done',
        ],
        requests,
      ),
    }).run({ sessionId: session.id, prompt: 'Implement and validate', autoVerify: true });
    assert.equal(await readFile(path.join(root, 'partial.txt'), 'utf8'), 'partial');
    if (hook === 'observer-failure')
      assert.match(
        store.messages(session.id).find((message) => message.role === 'tool')!.content,
        /Extension observer failed/,
      );
    assert.equal(result.status, 'needs_review');
    assert.equal(result.completion?.reason, 'missing-verification');
    assert.equal(requests.length, 3, 'one bounded reminder, then stop');
  });
}

for (const refusal of ['permission', 'unknown-id'] as const) {
  test(`a validation refused before execution (${refusal}) does not require verification`, async (t) => {
    const { root, store, session } = await storeFixture(t);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
    );
    const requests: ModelRequest[] = [];
    const result = await new Agent({
      store,
      tools: createTools(root),
      approve: async () => false,
      provider: scripted(
        [
          [
            {
              name: 'run_validation',
              arguments: { id: refusal === 'permission' ? 'npm:test' : 'npm:unknown' },
            },
          ],
          'Blocked',
        ],
        requests,
      ),
    }).run({ sessionId: session.id, prompt: 'Validate the project', autoVerify: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.completion, undefined);
    assert.equal(requests.length, 2, 'no reminder for a command that did not run');
    assert.match(
      store.messages(session.id).find((message) => message.role === 'tool')!.content,
      refusal === 'permission' ? /Permission denied/ : /Unknown or no longer available/,
    );
  });
}

test('a failed validation can register checks after the reminder and repair the work', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }),
  );
  await writeFile(
    path.join(root, 'partial.test.cjs'),
    "require('node:fs').writeFileSync('out.txt','wrong');process.exit(1)",
  );
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(
      [
        [
          {
            name: 'run_validation',
            arguments: { id: 'npm:test', files: ['partial.test.cjs'] },
          },
        ],
        'Done',
        [verify],
        'Done',
        [{ name: 'read_file', arguments: { path: 'out.txt' } }],
        [
          {
            name: 'edit_file',
            arguments: { path: 'out.txt', old_text: 'wrong', new_text: 'fixed' },
          },
        ],
        'Fixed',
      ],
      requests,
    ),
  }).run({ sessionId: session.id, prompt: 'Implement and validate', autoVerify: true });
  assert.match(JSON.stringify(requests[2]?.messages), /no verification checks yet/);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.completion?.state, 'verified');
  assert.equal(result.completion?.repairRounds, 1);
  assert.equal(result.completion?.verificationRound, 2);
  assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'fixed');
});

test('read-only requests are not offered automatic verification tools or reminders', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(['Explanation'], requests),
  }).run({ sessionId: session.id, prompt: 'Explain the code', readOnly: true, autoVerify: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.completion, undefined);
  assert.equal(
    requests[0]?.tools.some((tool) => tool.name === 'verify_work'),
    false,
  );
});

test('approval within a planning run enables automatic checks and preserves the approved steps', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const plan = store.createPlan(session.id);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    question: async () => ({
      answered: true,
      answers: [{ id: 'plan', selected: ['Approve and execute'] }],
    }),
    provider: scripted(
      [
        [
          {
            name: 'exit_plan_mode',
            arguments: {
              title: 'Produce output',
              summary: 'Create and check the output',
              steps: ['Write the output'],
            },
          },
        ],
        [verify],
        [
          write('fixed'),
          { name: 'completion_step', arguments: { id: `plan:${plan.id}:0`, status: 'completed' } },
        ],
        'Done',
      ],
      requests,
    ),
  }).run({
    sessionId: session.id,
    prompt: 'Plan and implement',
    planPhase: true,
    planId: plan.id,
    autoVerify: true,
  });
  assert.equal(result.completion?.state, 'verified', JSON.stringify(result));
  assert.equal(
    requests[0]?.tools.some((tool) => tool.name === 'verify_work'),
    false,
  );
  assert.equal(
    requests[1]?.tools.some((tool) => tool.name === 'verify_work'),
    true,
  );
  assert.equal(
    store.completionCurrent(session.id)?.planHash,
    store.getPlan(session.id, plan.id).hash,
  );
});

test('explicit checks remain authoritative when automatic verification is enabled', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(path.join(root, 'out.txt'), 'fixed');
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(['Done'], requests),
  }).run({
    sessionId: session.id,
    prompt: 'Check output',
    autoVerify: true,
    completion: {
      version: 1,
      objective: 'Keep user-defined checks',
      constraints: [],
      steps: [],
      inputs: ['out.txt'],
      acceptance: [
        {
          description: 'User check',
          met: false,
          check: { id: 'user', kind: 'file-contains', path: 'out.txt', expected: 'fixed' },
        },
      ],
    },
  });
  assert.equal(result.completion?.state, 'verified');
  assert.equal(
    requests[0]?.tools.some((tool) => tool.name === 'verify_work'),
    false,
  );
  assert.equal(store.completionCurrent(session.id)?.source, 'request');
});

test('a changed request cannot silently finish without verification', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([[write('fixed')], 'Done'], requests),
  }).run({ sessionId: session.id, prompt: 'Fix the output', autoVerify: true });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'unverified');
  assert.equal(result.completion?.reason, 'missing-verification');
  assert.equal(requests.length, 3, 'one bounded reminder, then stop');
  const answers = store
    .messages(session.id)
    .filter((message) => message.role === 'assistant' && message.content === 'Done');
  assert.equal(answers.length, 2, 'both answers stay in the model-visible transcript');
  assert.equal(
    answers[0]?.role === 'assistant' ? answers[0].provisional : undefined,
    true,
    'the answer replaced by the nudge is provisional',
  );
  assert.equal(
    answers[1]?.role === 'assistant' ? answers[1].provisional : undefined,
    undefined,
    'the final answer is not provisional',
  );
});

test('questions do not acquire a verification contract or an extra model round', async (t) => {
  const { root, store, session } = await storeFixture(t);
  const requests: ModelRequest[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(['An answer'], requests),
  }).run({ sessionId: session.id, prompt: 'Explain a concept', autoVerify: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.completion, undefined);
  assert.equal(requests.length, 1);
});

test('the agent cannot replace failing checks with an easier verification', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(path.join(root, 'out.txt'), 'wrong');
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([
      [verify],
      'Done',
      [
        {
          name: 'verify_work',
          arguments: {
            commands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
            inputs: ['out.txt'],
          },
        },
      ],
      'Done',
    ]),
  }).run({ sessionId: session.id, prompt: 'Fix the output', autoVerify: true });
  assert.notEqual(result.completion?.state, 'verified');
  assert.equal(
    store.completionCurrent(session.id)?.definition.acceptance[0]?.check?.command,
    check.command,
  );
  assert.match(JSON.stringify(store.messages(session.id)), /already.*registered|cannot.*replace/i);
});

test('verification permission refusal stops repair and is recorded', async (t) => {
  const { root, store, session } = await storeFixture(t);
  await writeFile(path.join(root, 'out.txt'), 'fixed');
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => false,
    provider: scripted([[verify], 'Done']),
  }).run({ sessionId: session.id, prompt: 'Verify the output', autoVerify: true });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.reason, 'permission-denied');
  assert.equal(result.completion?.repairRounds, 0);
});
