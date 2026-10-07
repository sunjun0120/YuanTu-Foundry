/**
 * A background command that finished after the turn that started it.
 *
 * `start_command` is the other place where work escapes its turn: the tool returns an id and the process keeps
 * running, so a build that fails ten minutes later has nowhere to report — the manager that knew the job is
 * memory, and the run that started it is over. What survives is the session's own log, and these tests hold the
 * promises that make it usable: the model is told on its next turn, it can still read the output (a bounded tail
 * of it survives the process), and the telling stops once it has read the result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { commandJournal, commandRecords } from '../packages/core/command-jobs.ts';
import { commandNotices, commandNoticeText } from '../packages/core/settlements.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { BackgroundCommands } from '../packages/tools/background.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolContext,
} from '../packages/protocol/index.ts';

/** Printed at the end of the output, so "the tail survived" is a claim about the *end* of what it said. */
const MARKER = 'SECRET-OUTPUT-42';
const reply = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
/** A provider whose answers are scripted per run, recording the system prompt each request carried. */
function scripted() {
  const systems: string[] = [];
  const requests: ModelRequest[] = [];
  let queue: ModelResponse[] = [];
  const provider: Provider = {
    async complete(request: ModelRequest) {
      systems.push(request.system);
      requests.push(request);
      const response = queue.shift();
      if (!response) throw new Error('the script ran out of answers');
      return response;
    },
  };
  return {
    provider,
    systems,
    requests,
    script: (...responses: ModelResponse[]) => {
      queue = [...responses];
    },
    system: () => systems.at(-1)!,
  };
}
/** The command's durable record once it has an outcome — the state a notice is about. */
async function settled(store: SessionStore, sessionId: string, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = commandRecords(store, sessionId).get(id);
    if (record?.status) return record;
    await delay(50);
  }
  throw new Error('the command never settled');
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-command-settlement-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const manager = new BackgroundCommands(root);
  const session = store.create(root);
  t.after(async () => {
    await manager.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // Two commands: one that finishes at once and prints a marker, one that keeps running until it is stopped.
  await writeFile(
    path.join(root, 'build.cjs'),
    `console.log("building");console.log("${MARKER}");`,
  );
  await writeFile(
    path.join(root, 'chatty.cjs'),
    `console.log("x".repeat(6000));console.log("${MARKER}");`,
  );
  await writeFile(path.join(root, 'wait.cjs'), 'console.log("WAITING");setInterval(()=>{},1000);');
  return { root, store, manager, session };
}
function toolFixture(
  root: string,
  manager: BackgroundCommands,
  store: SessionStore,
  sessionId: string,
) {
  const tools = createTools(root, manager, sessionId);
  // The run supplies the journal, exactly as `Agent` does; `jobs` is filled in by the registry.
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => true,
    commandJournal: commandJournal(store, sessionId),
  };
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.execute({ id: crypto.randomUUID(), name, arguments: args }, ctx);
    return result;
  };
  return { tools, ctx, run };
}

test('a command that finished after its turn is announced next turn, and reading it stops the notice', async (t) => {
  const { root, store, manager, session } = await fixture(t);
  const tools = createTools(root, manager, session.id);
  t.after(() => tools.close());
  const model = scripted();
  const agent = new Agent({
    store,
    provider: model.provider,
    tools,
    approve: async () => true,
  });

  // Turn one starts the build and answers; the process outlives the turn, which is the whole point.
  model.script(call('s1', 'start_command', { command: 'node build.cjs' }), reply('Build started.'));
  const first = await agent.run({ sessionId: session.id, prompt: 'Start the build' });
  assert.equal(first.status, 'completed', first.error);
  const id = [...commandRecords(store, session.id).keys()][0]!;
  const record = await settled(store, session.id, id);
  assert.equal(record.status, 'completed');
  assert.equal(record.exitCode, 0);

  // Turn two: the notice is in the request, names the command and how it ended, and points at the tool.
  model.script(reply('Nothing else to do.'));
  await agent.run({ sessionId: session.id, prompt: 'Anything to report?' });
  const notice = model.system();
  assert.match(notice, /Background commands you started that have finished/);
  assert.match(notice, /node build\.cjs: completed \(exit 0\)/);
  assert.match(notice, new RegExp(id));
  assert.match(notice, /Read one with `job_output`/);
  // The notice is instructions, not data: what the command printed belongs in a tool result, where the model
  // reads it as a program's output rather than as a line of its own prompt.
  assert.doesNotMatch(notice, new RegExp(MARKER));

  // Turn three reads it, which is delivery — and the output itself arrives as a tool result, which is the only
  // place a program's own words may reach the model from.
  model.script(call('r1', 'job_output', { id }), reply('The build passed.'));
  await agent.run({ sessionId: session.id, prompt: 'Read the build output' });
  assert.match(JSON.stringify(model.requests.at(-1)!.messages), new RegExp(MARKER));
  assert.ok(
    store.events(session.id).some((event) => event.type === 'command.collected'),
    'reading a finished command is the record that stops the notice',
  );

  // Turn four: delivered once, so it is no longer a thing the model has not been told. The prompt is composed at
  // the start of a run rather than per request, so it is the *next* run that stops carrying it.
  model.script(reply('Fine.'));
  await agent.run({ sessionId: session.id, prompt: 'And now?' });
  assert.doesNotMatch(model.system(), /Background commands you started/);
});

test('the tail is what survives the process, and job_output still answers for it', async (t) => {
  const { root, store, manager, session } = await fixture(t);
  const first = toolFixture(root, manager, store, session.id);
  await first.run('start_command', { command: 'node chatty.cjs' });
  const id = [...commandRecords(store, session.id).keys()][0]!;
  const record = await settled(store, session.id, id);
  // The record is bounded and says how much it is a tail *of*, so a reader can tell a short output from a cut one.
  assert.ok(record.outputChars >= 6000, `recorded ${record.outputChars} characters`);
  assert.equal(record.output.length, 3000);
  assert.ok(record.output.trimEnd().endsWith(MARKER), 'the tail is the end of what it printed');
  assert.doesNotMatch(record.output, /building/);

  /**
   * A second manager is a restarted Host: it holds no jobs at all, so the only thing left to answer from is the
   * session's log. Before this record existed, the model was reminded about a command and then told the command
   * did not exist — a notice it could never clear.
   */
  await first.tools.close();
  const restarted = new BackgroundCommands(root);
  t.after(() => restarted.close());
  const second = toolFixture(root, restarted, store, session.id);
  t.after(() => second.tools.close());
  const result = await second.run('job_output', { id });
  assert.equal(result.isError, false, result.content);
  const snapshot = JSON.parse(result.content);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.detail.recalled, true);
  assert.equal(snapshot.truncated, true, 'what the caller asked for is not all here');
  assert.equal(snapshot.nextCursor, record.outputChars);
  assert.ok(snapshot.output.trimEnd().endsWith(MARKER));
  /**
   * And the listing half: a restarted process owns no jobs, so `job_list` used to answer "this session has no
   * jobs" about a session whose own log names several. The record is what makes the session's work enumerable
   * rather than reachable only by an id somebody still remembers.
   */
  const listing = await second.run('job_list', {});
  assert.equal(listing.isError, false, listing.content);
  assert.match(listing.content, new RegExp(`- ${id} \\[command\\] \\[completed\\]`));
  assert.match(listing.content, /from the log/, 'the line says where it came from');
  assert.match(listing.content, new RegExp(record.command));
  // Reading the record is delivery too, so the notice does not outlive the process that could satisfy it.
  assert.deepEqual(commandNotices(store, session.id), []);
  assert.equal(commandNoticeText([]), '');
});

test('a job the process still holds is listed once, and a foreign session’s commands are not listed', async (t) => {
  /**
   * The other half of merging two sources: an id in both the live registry and the log must appear once — the live
   * one, because a running job is the more useful answer about it — and the durable records are the *session's*,
   * so a listing never reaches into another session's work.
   */
  const { root, store, manager, session } = await fixture(t);
  const { run, tools } = toolFixture(root, manager, store, session.id);
  t.after(() => tools.close());
  const started = JSON.parse((await run('start_command', { command: 'node wait.cjs' })).content);
  // Still running, so it is live only: no duplicate line from the record written at start.
  const live = await run('job_list', {});
  assert.equal(live.isError, false, live.content);
  assert.equal(
    live.content.split('\n').filter((text) => text.includes(started.id)).length,
    1,
    `one line per job: ${live.content}`,
  );
  assert.doesNotMatch(live.content, /from the log/);
  await run('job_kill', { id: started.id });
  await settled(store, session.id, started.id);
  // Now it is in both places, and it is still one line.
  const after = await run('job_list', {});
  assert.equal(
    after.content.split('\n').filter((text) => text.includes(started.id)).length,
    1,
    `still one line after it settled: ${after.content}`,
  );
  // Another session's journal lists nothing here, which is what "this session's own work" means.
  const other = toolFixture(root, manager, store, store.create(root).id);
  t.after(() => other.tools.close());
  const foreign = await other.run('job_list', {});
  assert.doesNotMatch(foreign.content, new RegExp(started.id));
});

test('peeking at a running command is not taking delivery of its outcome', async (t) => {
  const { root, store, manager, session } = await fixture(t);
  const { run, tools } = toolFixture(root, manager, store, session.id);
  t.after(() => tools.close());
  const started = JSON.parse((await run('start_command', { command: 'node wait.cjs' })).content);
  const peeked = await run('job_output', { id: started.id });
  assert.equal(JSON.parse(peeked.content).status, 'running');
  assert.equal(
    store.events(session.id).some((event) => event.type === 'command.collected'),
    false,
    'a running command has no outcome to have read',
  );
  // Once it ends — here by being stopped — it is exactly the state the notice is about.
  await run('job_kill', { id: started.id });
  await settled(store, session.id, started.id);
  const notices = commandNotices(store, session.id);
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(notices[0]!.status, 'cancelled');
  assert.equal(notices[0]!.id, started.id);
});

test('an id this session never started is still an unknown job', async (t) => {
  const { root, store, manager, session } = await fixture(t);
  const { run, tools } = toolFixture(root, manager, store, session.id);
  t.after(() => tools.close());
  const result = await run('job_output', { id: 'not-a-command' });
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown job/);
  assert.equal(commandNotices(store, session.id).length, 0);
});

test('a stop request for a command from an earlier process reports how it ended', async (t) => {
  /**
   * The second surface that could name the record rather than call it unknown.
   *
   * `job_output` was given the fallback first, because reading a finished command is what a notice asks for. A
   * *stop* is asked for on a live job — but the same restart makes every id the registry once knew unknown, and
   * "Unknown job" about a command this session's own log says ended is a false statement the model has no way to
   * correct: it will report an unstoppable job to the user, or try again. The honest answer is the record.
   */
  const { root, store, manager, session } = await fixture(t);
  const first = toolFixture(root, manager, store, session.id);
  await first.run('start_command', { command: 'node build.cjs' });
  const id = [...commandRecords(store, session.id).keys()][0]!;
  await settled(store, session.id, id);
  await first.tools.close();
  const restarted = new BackgroundCommands(root);
  t.after(() => restarted.close());
  const second = toolFixture(root, restarted, store, session.id);
  t.after(() => second.tools.close());

  const killed = await second.run('job_kill', { id });
  assert.equal(killed.isError, false, killed.content);
  assert.match(killed.content, /already ended \(completed, exit 0\)/);
  assert.match(killed.content, /nothing left to stop/);
  assert.doesNotMatch(killed.content, /Stopped /, 'nothing was stopped, so nothing says it was');
  assert.doesNotMatch(killed.content, /Unknown job/);
  const snapshot = JSON.parse(killed.content.slice(killed.content.indexOf('{')));
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.detail.recalled, true);
  /**
   * And the fallback stays narrow: an id the log does not record is still the registry's own error, so a stop
   * request cannot be answered with a fabricated record of somebody else's work.
   */
  const foreign = await second.run('job_kill', { id: 'not-a-command' });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content, /Unknown job/);
});

test('a command whose outcome was never recorded is not reported as stopped', async (t) => {
  /**
   * The other half of answering from the record: a `command.started` with no `command.settled` is a process that
   * died without saying how — a crash, or a Host that was killed. Whether it is still running somewhere is
   * exactly what nobody knows, and the recorded pid cannot decide it (pids are reused, so signalling one from a
   * log is how a stop request kills an unrelated process). The answer has to say that instead of either
   * "stopped" or "unknown job".
   */
  const { root, store, manager, session } = await fixture(t);
  commandJournal(store, session.id).started({
    id: 'lost-1',
    sessionId: session.id,
    command: 'node wait.cjs',
    cwd: root,
    createdAt: new Date().toISOString(),
  });
  const { run, tools } = toolFixture(root, manager, store, session.id);
  t.after(() => tools.close());

  const result = await run('job_kill', { id: 'lost-1' });
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /has no outcome/);
  assert.match(result.content, /whether it finished is unknown/);
  assert.doesNotMatch(result.content, /Stopped /);
  assert.doesNotMatch(result.content, /Unknown job/);
  const snapshot = JSON.parse(result.content.slice(result.content.indexOf('{')));
  assert.equal(snapshot.status, 'unknown');
  assert.equal(snapshot.detail.recalled, true);
});
