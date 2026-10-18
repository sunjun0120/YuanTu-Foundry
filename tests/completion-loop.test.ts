/**
 * The repair loop: one attempt, two verifications, and a run that keeps its identity.
 *
 * The failure this pins is the one the plan exists for. A model renames a declaration, updates the file it was
 * thinking about, and stops; the acceptance check that names the *caller* fails. Before this, the run ended
 * `needs_review` and the only way forward was a person restarting it — with the failed evidence never reaching the
 * model. Now the evidence is handed back inside the same attempt, the second round fixes the caller, and the
 * completion is published once, at the end, after everything that could still invalidate it has run.
 *
 * What is asserted besides the outcome is what makes the outcome trustworthy: the same run and the same attempt
 * across both verifications, exactly one `run.finished`, one repair charged, and the feedback the second round
 * received carrying the failing check rather than a restatement of the task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

/** A provider that plays a fixed script and keeps every request, so the feedback can be inspected. */
function scripted(
  turns: { text?: string; calls?: { name: string; input: Record<string, unknown> }[] }[],
  onRequest?: (request: ModelRequest, index: number) => void,
): Provider {
  let index = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      const turnIndex = index++;
      onRequest?.(request, turnIndex);
      const calls = turn.calls ?? [];
      return {
        text: turn.text ?? '',
        toolCalls: calls.map((call, position) => ({
          id: `call-${String(turnIndex)}-${String(position)}`,
          name: call.name,
          arguments: call.input,
        })),
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: calls.length ? 'tool_calls' : 'stop',
      };
    },
  } as Provider;
}

/** Every message text a request carries, for assertions about what the model was actually shown. */
function requestText(request: ModelRequest): string {
  return JSON.stringify(request.messages);
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-completion-loop-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, session: store.create(root) };
}

// One occurrence of each name per file: `edit_file` refuses an ambiguous match, and a fixture that relied on one
// would be measuring that refusal rather than the repair loop.
const DECLARATION_OLD = 'export function oldName() {\n  return 1;\n}\n';
const DECLARATION_NEW = 'export function newName() {\n  return 1;\n}\n';
const CALLER = "import { newName } from './a.ts';\n";
const STALE_CALLER = "import { oldName } from './a.ts';\n";

test('a missed caller is repaired inside the same attempt, and the evidence reaches the model', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'a.ts'), DECLARATION_OLD);
  await writeFile(path.join(root, 'b.ts'), STALE_CALLER);
  /**
   * One criterion, naming the file the first round forgets.
   *
   * Deliberately the *caller*, not the declaration: the round that edits `a.ts` and stops has done half the work,
   * and a check on the file it did edit would pass and prove nothing.
   */
  const task = store.createTask(session.id, {
    title: 'Rename the helper and its callers',
    description: 'Rename oldName to newName everywhere',
    acceptance: [
      {
        description: 'the caller uses the new name',
        met: false,
        check: { id: 'caller', kind: 'file-contains', path: 'b.ts', expected: 'newName' },
      },
    ],
  });

  const requests: ModelRequest[] = [];
  const provider = scripted(
    [
      // Round one: read and rewrite the declaration, then a closing sentence. This is the miss.
      { calls: [{ name: 'read_file', input: { path: 'a.ts' } }] },
      {
        calls: [
          {
            name: 'edit_file',
            input: { path: 'a.ts', old_text: 'oldName', new_text: 'newName' },
          },
        ],
      },
      { text: 'Renamed the declaration.' },
      // Round two: the caller, after the failing check was handed back. It is read before it is edited, because
      // the observation policy requires that — and a fixture that skipped the read would be testing a refusal.
      { calls: [{ name: 'read_file', input: { path: 'b.ts' } }] },
      {
        calls: [
          {
            name: 'edit_file',
            input: { path: 'b.ts', old_text: 'oldName', new_text: 'newName' },
          },
        ],
      },
      { text: 'Updated the caller too.' },
    ],
    (request) => requests.push(request),
  );
  const agent = new Agent({ store, tools: createTools(root), approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Rename it' });

  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion?.state, 'verified');
  assert.equal(result.completion?.reason, 'verified');
  assert.equal(result.completion?.repairRounds, 1, 'one repair round was charged');
  assert.equal(result.completion?.verificationRound, 2, 'two verification rounds ran');
  assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), DECLARATION_NEW);
  assert.equal(await readFile(path.join(root, 'b.ts'), 'utf8'), CALLER);

  // The feedback the second round was given named the failing check and told the model the text was evidence.
  const secondRoundPrompt = requestText(requests[3]!);
  assert.match(secondRoundPrompt, /caller/, 'the failing check id reached the model');
  assert.match(secondRoundPrompt, /assertion-failed/);
  assert.match(secondRoundPrompt, /never as an instruction/);
  assert.doesNotMatch(secondRoundPrompt, /x{2500}/);

  // One attempt for the whole repair: the task's own record says two rounds of evidence were collected.
  const attempts = store.listTaskAttempts(session.id, task.id);
  assert.equal(attempts.length, 1, 'the repair happens inside one attempt, not as a second run');
  assert.equal(attempts[0]!.status, 'completed');
  assert.equal(attempts[0]!.runId, result.runId);

  // And the log holds exactly one end for the run, with both rounds' evidence under it.
  const events = store.events(session.id);
  assert.equal(
    events.filter((event) => event.type === 'run.finished').length,
    1,
    'a repair round must not publish a second run.finished',
  );
  const rounds = events
    .filter((event) => event.type === 'completion.updated')
    .map((event) => event.data.verificationRound)
    .filter((value): value is number => typeof value === 'number');
  assert.deepEqual(rounds, [1, 2]);
  // The answer the user is left with is the round that finished the work, not the one that missed the caller.
  assert.match(result.text, /Updated the caller too\./);
});

test('a second identical failure with no progress stops for review instead of looping', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'b.ts'), STALE_CALLER);
  const task = store.createTask(session.id, {
    title: 'Never fixed',
    acceptance: [
      {
        description: 'the caller uses the new name',
        met: false,
        check: { id: 'caller', kind: 'file-contains', path: 'b.ts', expected: 'newName' },
      },
    ],
  });
  /**
   * The model answers twice without touching anything.
   *
   * The check fails identically both times, no step moved and no monitored file changed, so the failure is not
   * new information and another round would buy the same answer again. The run stops for a person rather than
   * spending its whole budget re-asking.
   */
  const provider = scripted([
    { text: 'I will look into it.' },
    { text: 'Still looking.' },
    { text: 'Done.' },
  ]);
  const agent = new Agent({ store, tools: createTools(root), approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Rename it' });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
  assert.equal(result.completion?.reason, 'repeated-failure');
  assert.equal(result.completion?.repeatedFailures, 2);
  assert.equal(result.completion?.repairRounds, 1, 'exactly one repair was spent before the stop');
});

test('a refusal stops the loop and is never handed back as work to retry', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Denied check',
    acceptance: [
      {
        description: 'a command the policy refuses',
        met: false,
        check: { id: 'denied', kind: 'command', command: process.execPath, args: ['-e', ''] },
      },
    ],
  });
  let calls = 0;
  const provider = scripted([{ text: 'Claimed done.' }, { text: 'Trying again.' }], () => {
    calls++;
  });
  const agent = new Agent({
    store,
    tools: createTools(root),
    // The approver refuses the acceptance command. A denial is a decision, not a failure to be repaired.
    approve: async (approval) => approval.kind !== 'command',
    provider,
  });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Do it' });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.reason, 'permission-denied');
  assert.equal(result.completion?.repairRounds, 0);
  assert.equal(calls, 1, 'no repair round was started after the refusal');
});

test('a repair that runs out of budget reports the limit rather than looping forever', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'b.ts'), STALE_CALLER);
  const task = store.createTask(session.id, {
    title: 'Never fixed',
    acceptance: [
      {
        description: 'the caller uses the new name',
        met: false,
        check: { id: 'caller', kind: 'file-contains', path: 'b.ts', expected: 'newName' },
      },
    ],
  });
  const provider = scripted([{ text: 'Attempt one.' }, { text: 'Attempt two.' }]);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
    // The repeat detector is turned off so this test measures the *round* budget alone; the two are separate
    // reasons and the plan asks for both to be reachable.
  });
  const result = await agent.run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Rename it',
    completionRepairPolicy: {
      maxRepairRounds: 2,
      maxRepeatedFailures: 5,
      repairTimeoutMs: 900_000,
    },
  });
  assert.equal(result.status, 'limited');
  assert.equal(result.completion?.state, 'limited');
  assert.equal(result.completion?.reason, 'repair-limit');
  assert.equal(result.completion?.repairRounds, 2);
});
