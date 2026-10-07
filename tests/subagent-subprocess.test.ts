/**
 * The out-of-process provider, exercised by really running a child process.
 *
 * The tempting way to test this is to inject a fake spawner and assert the provider called it — which would prove
 * nothing about the part that is hard. So this suite runs the actual CLI in a real child process against a real
 * HTTP fixture, and the assertions are about the child's *answer* coming back: a stub cannot produce one.
 *
 * The three properties under test are the ones the design decided, not incidental behaviour: the child owns its
 * world (so a write-capable task is refused rather than run somewhere it cannot affect anything), the report is
 * composed from what the child said (because a separate process has no `submit_report` tool to enforce a shape
 * with), and stopping is killing (so an abort reports cancellation, not a failed child).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import {
  readChildResult,
  reportFromChild,
  subprocessProvider,
} from '../packages/core/subagent-subprocess.ts';
import type { ResolvedSubAgentStartRequest } from '../packages/core/subagent-providers.ts';

/** A start request as the coordinator would build it, with only what this provider reads. */
function request(
  overrides: {
    objective?: string;
    context?: string;
    role?: 'explore' | 'general';
    signal?: AbortSignal;
    started?: (sessionId: string) => void;
  } = {},
): ResolvedSubAgentStartRequest {
  return {
    provider: 'subprocess',
    task: {
      id: 'task-1',
      index: 0,
      role: overrides.role ?? 'explore',
      objective: overrides.objective ?? 'Say what you were asked to say',
      ...(overrides.context ? { context: overrides.context } : {}),
    },
    parent: { sessionId: 'parent-1', workspace: process.cwd(), depth: 0 },
    options: {},
    signal: overrides.signal ?? new AbortController().signal,
    started: overrides.started ?? (() => undefined),
  };
}
/**
 * The CLI entrypoint, spawned exactly as a deployment would spawn it.
 *
 * No `cwd` and no workspace: the provider owns both, which is the property the first test in this file checks the
 * consequences of — a provider that let the child inherit this repository would be delegating into the parent's own
 * database.
 */
const providerFor = (url: string, extra: { timeoutMs?: number; maxContextTokens?: number } = {}) =>
  subprocessProvider({
    script: path.resolve('apps/cli/main.ts'),
    scriptArgs: ['run'],
    maxContextTokens: extra.maxContextTokens ?? 128_000,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    env: {
      // The child is a real CLI run, and a run with no declared window is refused before its first request
      // (`declaredCapacity`). The window belongs to the child's own connection, so the fixture declares it.
      YUANTU_MAX_CONTEXT_TOKENS: String(extra.maxContextTokens ?? 128_000),
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'subprocess-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_BASE_URL: url,
    },
  });

test('a child runs in its own process and its answer comes back as a composed report', async (t) => {
  const bodies: unknown[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    sendFrames(res, frames('The answer is 42.'));
  });
  const started: string[] = [];
  const outcome = await providerFor(url).start(request({ started: (id) => started.push(id) }));
  assert.equal(outcome.status, 'completed', outcome.error);
  assert.equal(outcome.text.trim(), 'The answer is 42.');
  // The request really reached the endpoint from the *child* process, which is what makes this out of process.
  assert.ok(bodies.length >= 1, 'the child made its own model request');
  // No `started()`: the child session lives in the child's own database, so there is no session here to name. The
  // provider reports its id in the outcome instead, and `started` is reserved for a child this process can reach.
  assert.deepEqual(started, []);
  assert.match(outcome.sessionId, /\S/, 'the child session id comes back in the outcome');
  // The report is composed, and says where its evidence came from rather than implying it was verified here.
  assert.equal(outcome.report?.findings.length, 1);
  assert.match(outcome.report!.findings[0]!.evidence, /The answer is 42\./);
  assert.match(outcome.report!.unverified![0]!, /ran in its own process and workspace/);
  assert.ok(outcome.usage, 'the child reports what it spent, and the parent folds that in');
});

test('a write-capable task is refused, because the child cannot affect this workspace', async (t) => {
  // The honest half of "the child owns its world": the in-process provider promises that a child's file changes
  // are journalled against the parent session, and this one cannot, so it must say so instead of running a
  // `general` child somewhere its writes mean nothing.
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('unreachable')));
  const outcome = await providerFor(url).start(request({ role: 'general' }));
  assert.equal(outcome.status, 'failed');
  assert.match(String(outcome.error), /runs the child in its own workspace/);
  assert.match(String(outcome.error), /write-capable task is refused/);
  assert.match(String(outcome.error), /explore/);
});

test('a child that never answers is killed on its budget and says which budget it was', async (t) => {
  /**
   * A process that exits without a `result` frame did not answer, and reporting that as an empty report would be
   * the "accepted and ignored" shape this whole seam refuses.
   *
   * The fixture holds the request open rather than failing it: an endpoint that *errors* still lets the CLI finish
   * and print a result frame — a failed run is still a result, which this file asserts elsewhere. The case worth
   * testing is a child that never gets there, and it is also the case the design called out: a separate process can
   * only be stopped, not asked to wind down. So the budget is a hard kill, and the message says which limit it was
   * instead of blaming the child.
   */
  const url = await httpFixture(t, (_body, res) => {
    // Never answer and never end: the child stays inside a model request until it is killed.
    void res;
  });
  const outcome = await providerFor(url, { timeoutMs: 800 }).start(request());
  assert.equal(outcome.status, 'failed');
  assert.match(String(outcome.error), /killed after 800ms without reporting a result/);
  assert.match(String(outcome.error), /hard limit rather than a cooperative one/);
  assert.equal(outcome.report, undefined);
});

test('aborting the call kills the child and reports cancellation, not a failed child', async (t) => {
  // The only stop this provider has is a signal to the process, and a parent that cancelled the work must not read
  // its own decision back as the child's fault.
  const url = await httpFixture(t, (_body, res) => {
    // Never answer: the child stays in a model request until it is killed.
    void res;
  });
  const controller = new AbortController();
  const pending = providerFor(url, { timeoutMs: 60_000 }).start(
    request({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 300);
  const outcome = await pending;
  assert.equal(outcome.status, 'cancelled');
  assert.match(String(outcome.error), /aborted, which kills the process/);
});

test('a child completes in a scratch world even when this checkout has a database of its own', async (t) => {
  /**
   * The regression the first version of this provider hit, kept as a test because the failure is silent otherwise.
   *
   * The CLI resolves its workspace from `--workspace` — an environment variable is *not* read for it — and its
   * database from `<workspace>/.yuantu/sessions.sqlite`. Spawned with neither, a child inherits the parent's
   * workspace and opens the parent's database; the first version did exactly that and died on a database format its
   * own build had not written, while the parent's database sat unchanged beside it. A checkout with no database, or
   * with one whose format happened to match, would have hidden that.
   *
   * What this asserts is the consequence: the child starts, runs and answers regardless of what is in this
   * repository — and reaches the endpoint itself, which is what makes it out of process rather than a second call
   * from here. The mechanism (both paths passed explicitly at the spawn site) is documented there.
   */
  const url = await httpFixture(t, (_body, res) => {
    sendFrames(res, frames('SCRATCH-OK'));
  });
  const outcome = await providerFor(url).start(
    request({ objective: 'Answer with the probe word' }),
  );
  assert.equal(outcome.status, 'completed', outcome.error);
  assert.equal(outcome.text.trim(), 'SCRATCH-OK');
  // The child's session id belongs to its scratch database, so nothing here can look it up — which is the only
  // thing "out of process" can mean if it means anything.
  assert.match(outcome.sessionId, /\S/);
});

test('the child result reader takes the last result frame and survives frames it cannot parse', async () => {
  /**
   * The stream a real child writes is the whole run: events, retries, per-round narration and one or more result
   * frames. Two rules matter and both are cheap to get wrong — a malformed frame must not lose a completed run,
   * and when the CLI prints a result per goal continuation round the parent wants the *last* one (where the session
   * arrived, not where it started).
   */
  const first = JSON.stringify({
    type: 'result',
    result: { sessionId: 's1', status: 'completed', text: 'first' },
  });
  const last = JSON.stringify({
    type: 'result',
    result: { sessionId: 's2', status: 'completed', text: 'last' },
  });
  // The malformed line is a *truncated frame*, not prose: this reader counts only lines that were trying to be
  // JSON, so a human-readable line cannot inflate a metric an operator reads as "the child is broken".
  const stream = [
    '{"type":"event","event":{}}',
    '{"type":"result","result":',
    first,
    '',
    last,
    '',
  ].join('\n');
  const { result, malformed } = readChildResult(stream);
  assert.equal(malformed, 1, 'the truncated frame is counted rather than thrown on');
  // Prose on the stream (the CLI writes narration to stderr, but a wrapper might merge them) is not a frame.
  assert.equal(readChildResult('warning: something happened\n').malformed, 0);
  assert.equal(result?.text, 'last');
  assert.equal(result?.sessionId, 's2');
  // A stream with no result frame is the caller's problem, not this function's: it reports absence.
  assert.equal(readChildResult('{"type":"event"}\n').result, undefined);
});

test('a composed report bounds an enormous answer instead of shipping it whole', async () => {
  // The report is a summary surface: the child's full answer is quoted as evidence, but the one-line summary a
  // card and a settlement notice read must stay bounded or every fan-out pays for the longest child.
  const report = reportFromChild('x'.repeat(5_000), 'child-1');
  assert.equal(report.summary.length, 401, 'truncated with an ellipsis');
  assert.equal(
    report.findings[0]!.evidence.length,
    5_000,
    'the evidence is the answer, not a copy of the summary',
  );
  assert.match(report.unverified![0]!, /child-1/);
});
