/**
 * `ask_user_question`: the decision seam.
 *
 * An approval asks "may I?" and answers a boolean; a question asks "which?" and answers a shape. The
 * difference matters most when the wait ends *without* an answer, which is the normal outcome for a
 * scheduled run or a desktop window nobody is looking at: the tool must still return a result, and the
 * model must be told not to sit there waiting for a reply that is never coming.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';
import type {
  QuestionOutcome,
  QuestionRequest,
  Questioner,
  ToolResult,
} from '../packages/protocol/index.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

const hostPath = path.resolve('apps/agent-host/main.ts');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-question-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, tools: createTools(root) };
}
const call = (args: Record<string, unknown>) => ({
  id: 'call-question',
  name: 'ask_user_question',
  arguments: args,
});
/** The registry turns a tool throw into an error result, but a hook may rethrow; accept either shape. */
async function execute(
  tools: ReturnType<typeof createTools>,
  args: Record<string, unknown>,
  questioner?: Questioner,
  signal = new AbortController().signal,
): Promise<ToolResult> {
  try {
    return await tools.execute(call(args), {
      signal,
      approve: async () => true,
      callId: 'call-question',
      ...(questioner ? { ask: questioner } : {}),
    });
  } catch (error) {
    return { isError: true, content: error instanceof Error ? error.message : String(error) };
  }
}
const oneQuestion = {
  questions: [
    { id: 'color', question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue' }] },
  ],
};

test('an answered question reports the selection keyed by question id', async (t) => {
  const { tools } = await fixture(t);
  const result = await execute(tools, oneQuestion, async () => ({
    answered: true,
    answers: [{ id: 'color', selected: ['blue'] }],
  }));
  assert.equal(result.isError, false);
  assert.match(result.content, /The user answered:/);
  assert.match(result.content, /blue/);
  assert.doesNotMatch(result.content, /Do not wait and do not ask again/);
});

test('free text and multi-select answers both survive the round trip', async (t) => {
  const { tools } = await fixture(t);
  const result = await execute(
    tools,
    {
      questions: [
        {
          id: 'targets',
          question: 'Which targets?',
          multiSelect: true,
          options: [{ label: 'lint' }, { label: 'test' }],
        },
        { id: 'note', question: 'Anything else?', allowFreeText: true },
      ],
    },
    async () => ({
      answered: true,
      answers: [
        { id: 'targets', selected: ['lint', 'test'] },
        { id: 'note', selected: [], freeText: 'ship it' },
      ],
    }),
  );
  assert.match(result.content, /selected: lint, test/);
  assert.match(result.content, /free text: ship it/);
});

test('a questioner that ignores the signal still cannot outlast the timeout', async (t) => {
  const { tools } = await fixture(t);
  // Never settles and never honours the abort: the tool's own bound has to end the wait anyway.
  const stuck: Questioner = () => new Promise<QuestionOutcome>(() => {});
  const started = Date.now();
  const result = await execute(tools, { ...oneQuestion, timeoutMs: 1000 }, stuck);
  assert.equal(result.isError, false);
  assert.match(result.content, /did not answer before the wait timed out/);
  assert.match(result.content, /Do not wait and do not ask again/);
  assert.ok(Date.now() - started < 5000, 'the timeout must bound the wait');
});

test('a questioner that throws is reported as unavailable rather than as a failed call', async (t) => {
  const { tools } = await fixture(t);
  const result = await execute(tools, oneQuestion, async () => {
    throw new Error('transport is down');
  });
  assert.equal(result.isError, false, 'the model must not retry a failure it cannot fix');
  assert.match(result.content, /No user is available to answer/);
});

test('an embedder without a questioner is told to proceed on an assumption, not handed an error', async (t) => {
  const { tools } = await fixture(t);
  const result = await execute(tools, oneQuestion);
  assert.equal(result.isError, false);
  assert.match(result.content, /No user is available to answer/);
  assert.match(result.content, /state it explicitly/);
});

test('ambiguous questions are refused before anyone is asked', async (t) => {
  const { tools } = await fixture(t);
  const duplicateId = await execute(tools, {
    questions: [
      { id: 'same', question: 'One?' },
      { id: 'same', question: 'Two?' },
    ],
  });
  assert.equal(duplicateId.isError, true);
  assert.match(duplicateId.content, /Duplicate question id/);
  // The schema's `pattern` refuses this one before `normalize` sees it; either way it never reaches a user.
  const badId = await execute(tools, { questions: [{ id: 'Not An Id', question: 'Which?' }] });
  assert.equal(badId.isError, true);
  assert.match(badId.content, /id/i);
  const repeatedLabel = await execute(tools, {
    questions: [{ id: 'dup', question: 'Which?', options: [{ label: 'a' }, { label: 'a' }] }],
  });
  assert.equal(repeatedLabel.isError, true);
  assert.match(repeatedLabel.content, /repeats an option label/);
  /**
   * Two recommendations are two answers. The badge says "the asker would pick this one", so a question that marks
   * two of them is refused rather than drawn with both — the interface cannot choose between them, and picking
   * one silently would be inventing a recommendation the model did not make.
   */
  const twoRecommendations = await execute(tools, {
    questions: [
      {
        id: 'rec',
        question: 'Which?',
        options: [
          { label: 'a', recommended: true },
          { label: 'b', recommended: true },
        ],
      },
    ],
  });
  assert.equal(twoRecommendations.isError, true);
  assert.match(twoRecommendations.content, /more than one option as recommended/);
});

test('a recommendation survives normalization as a flag, not as part of the label', async (t) => {
  const { tools } = await fixture(t);
  /** What the questioner was actually handed — the shape the panel draws, distinct from the tool result. */
  const asked: QuestionRequest[] = [];
  const questioner: Questioner = async (request) => {
    asked.push(request);
    return { answered: true, answers: [{ id: request.questions[0]!.id, selected: [] }] };
  };
  const answered = await execute(
    tools,
    {
      questions: [
        {
          id: 'color',
          question: 'Which colour?',
          options: [
            { label: 'red', description: 'the default', recommended: true },
            { label: 'blue' },
          ],
        },
      ],
    },
    questioner,
  );
  assert.equal(answered.isError, false);
  assert.deepEqual(asked.at(-1)!.questions[0]!.options, [
    { label: 'red', description: 'the default', recommended: true },
    { label: 'blue' },
  ]);
  // `false` is not carried: the field means "this one", and an option that does not say so is the default.
  const plain = await execute(
    tools,
    {
      questions: [
        { id: 'shape', question: 'Which?', options: [{ label: 'a', recommended: false }] },
      ],
    },
    questioner,
  );
  assert.equal(plain.isError, false);
  assert.deepEqual(asked.at(-1)!.questions[0]!.options, [{ label: 'a' }]);
});

test('the desktop contract accepts a well-formed answer and refuses a malformed one', () => {
  const parsed = parseCarrierCommand({
    type: 'questionAnswer',
    id: 'q-1',
    answers: [{ id: 'color', selected: ['blue'], freeText: 'because' }],
  });
  assert.deepEqual(parsed, {
    type: 'questionAnswer',
    id: 'q-1',
    answers: [{ id: 'color', selected: ['blue'], freeText: 'because' }],
  });
  assert.deepEqual(parseCarrierCommand({ type: 'questionAnswer', id: 'q-1', cancelled: true }), {
    type: 'questionAnswer',
    id: 'q-1',
    cancelled: true,
  });
  const invalid = [
    { type: 'questionAnswer', id: 'q-1' },
    { type: 'questionAnswer', id: '', cancelled: true },
    { type: 'questionAnswer', id: 'q-1', answers: [] },
    { type: 'questionAnswer', id: 'q-1', answers: [{ id: 'a', selected: [1] }] },
    { type: 'questionAnswer', id: 'q-1', answers: [{ id: 'a', selected: [], extra: true }] },
    { type: 'questionAnswer', id: 'q-1', cancelled: 'yes' },
  ];
  for (const command of invalid)
    assert.throws(() => parseCarrierCommand(command), /Invalid carrier command/);
});

test('the Host publishes the question, waits, and resumes on the answer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-question-host-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'theme.txt'), 'red\n');
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0) {
      sendFrames(
        res,
        frames('', [
          {
            id: 'ask-1',
            name: 'ask_user_question',
            input: {
              questions: [
                {
                  id: 'color',
                  question: 'Which colour should the theme use?',
                  options: [{ label: 'red' }, { label: 'blue' }],
                },
              ],
            },
          },
        ]),
      );
      return;
    }
    // The answer has to reach the model, which is the only reason asking is worth the wait.
    assert.match(JSON.stringify(body.messages), /blue/);
    sendFrames(res, frames('Using blue.'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'question-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  cleanups.push(() => client.stop());
  const seen: string[] = [];
  let questionId = '';
  let resolveQuestion!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveQuestion = resolve;
  });
  client.subscribe((event) => {
    seen.push(event.type);
    if (event.type === 'question.required') {
      questionId = String(event.data.questionId);
      resolveQuestion();
    }
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Pick a theme colour.');
  await pending;
  assert.ok(questionId, 'the Host must publish an id the client can answer');
  await client.request('question.respond', {
    questionId,
    answers: [{ id: 'color', selected: ['blue'] }],
  });
  const result = await running;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(seen.filter((type) => type === 'question.required').length, 1);
  const history = (await client.request('session.get', { sessionId: session.id })).messages;
  const asked = history.find((message) => message.role === 'tool');
  assert.match(String(asked?.content), /blue/);
});

test('an unanswered question times out and the run finishes instead of hanging', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-question-timeout-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0) {
      sendFrames(
        res,
        frames('', [
          {
            id: 'ask-1',
            name: 'ask_user_question',
            input: { questions: [{ id: 'color', question: 'Which colour?' }] },
          },
        ]),
      );
      return;
    }
    assert.match(JSON.stringify(body.messages), /did not answer before the wait timed out/);
    sendFrames(res, frames('Assuming blue.'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'question-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      // Runs through the same settings table the kernel reads, so this also proves the name is wired. The
      // value is the lowest the table allows: an out-of-range one is refused at startup, by design.
      YUANTU_QUESTION_TIMEOUT_MS: '1000',
    },
  });
  cleanups.push(() => client.stop());
  await client.start();
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Pick a theme colour.');
  assert.equal(result.status, 'completed', result.error);
});
