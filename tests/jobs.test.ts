/**
 * The unified job control plane.
 *
 * Commands and sub-agents used to answer "list / read / stop" through two different pairs of tools, so a
 * caller had to know which vocabulary matched which kind of work. These tests pin the convergence: one list,
 * one reader, one stopper, and a registry that refuses to guess when an id is ambiguous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { JobRegistry } from '../packages/protocol/jobs.ts';
import type { JobKind, JobProducer, JobSnapshot } from '../packages/protocol/jobs.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const snapshot = (over: Partial<JobSnapshot> & { id: string; kind: JobKind }): JobSnapshot => ({
  sessionId: 'session-a',
  label: `${over.kind} work`,
  status: 'running',
  createdAt: '2026-09-30T00:00:00.000Z',
  output: '',
  nextCursor: 0,
  truncated: false,
  ...over,
});
/** A producer with no moving parts, so the registry and the tools are what is under test. */
const fake = (kind: JobKind, jobs: JobSnapshot[]): JobProducer => ({
  kind,
  owns: ({ id, scope }) =>
    jobs.some((job) => job.id === id && job.sessionId === scope && job.kind === kind),
  list: (scope) => jobs.filter((job) => job.sessionId === scope && job.kind === kind),
  output: async ({ id, scope, cursor }) => ({
    ...jobs.find((job) => job.id === id && job.sessionId === scope)!,
    output: 'new output',
    nextCursor: cursor + 10,
  }),
  kill: async ({ id, scope }) => ({
    ...jobs.find((job) => job.id === id && job.sessionId === scope)!,
    status: 'cancelled',
  }),
});
async function root(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const ctx = (jobs?: JobRegistry): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  ...(jobs ? { jobs } : {}),
});
test('the wait the schema advertises is the budget the call actually has', async (t) => {
  /**
   * The wait used to be capped at five seconds by a constant written into the schema, while the registry gave the
   * call ten minutes — so the description's "wait up to wait_ms" was a promise the tool could not keep, and a model
   * waiting on a build had to ask over and over. The two numbers are one number now, and it is the operator's:
   * `YUANTU_TOOL_TIMEOUT_MS` moves the deadline and the schema together.
   */
  const directory = await root(t);
  const waitOf = (tools: ReturnType<typeof createTools>): number | undefined => {
    const spec = tools.specs().find((candidate) => candidate.name === 'job_output')!;
    const schema = spec.inputSchema as { properties?: { wait_ms?: { maximum?: number } } };
    return schema.properties?.wait_ms?.maximum;
  };
  const before = process.env.YUANTU_TOOL_TIMEOUT_MS;
  t.after(() => {
    if (before === undefined) delete process.env.YUANTU_TOOL_TIMEOUT_MS;
    else process.env.YUANTU_TOOL_TIMEOUT_MS = before;
  });
  delete process.env.YUANTU_TOOL_TIMEOUT_MS;
  const byDefault = createTools(directory, undefined, 'session-a');
  t.after(() => byDefault.close());
  assert.equal(
    waitOf(byDefault),
    600_000,
    'the shipped tool budget, which is what the call may take',
  );
  // The knob the operator already has moves both halves, so no second setting is invented for this one wait.
  process.env.YUANTU_TOOL_TIMEOUT_MS = '45000';
  const shorter = createTools(directory, undefined, 'session-a');
  t.after(() => shorter.close());
  assert.equal(waitOf(shorter), 45_000);
  // With the deadline turned off there is no budget to state, so the schema states what a call may take rather
  // than advertising an unbounded wait.
  process.env.YUANTU_TOOL_TIMEOUT_MS = '0';
  const unbounded = createTools(directory, undefined, 'session-a');
  t.after(() => unbounded.close());
  assert.equal(waitOf(unbounded), 600_000);
});

test('one list names every kind of job, and each id dispatches to its own producer', async (t) => {
  const directory = await root(t);
  const tools = createTools(directory, undefined, 'session-a');
  t.after(() => tools.close());
  const registry = new JobRegistry();
  registry.register(
    fake('command', [snapshot({ id: 'cmd-1', kind: 'command', label: 'npm test' })]),
  );
  registry.register(
    fake('subagent', [snapshot({ id: 'child-1', kind: 'subagent', label: 'Sweep the config' })]),
  );
  const listed = await tools.execute(
    { id: 'list', name: 'job_list', arguments: {} },
    ctx(registry),
  );
  assert.equal(listed.isError, false, listed.content);
  assert.match(listed.content, /cmd-1 \[command\] \[running\] npm test/);
  assert.match(listed.content, /child-1 \[subagent\] \[running\] Sweep the config/);
  // The same two tools read and stop either kind; only the id decides which producer answers.
  const read = await tools.execute(
    { id: 'read', name: 'job_output', arguments: { id: 'child-1', cursor: 0 } },
    ctx(registry),
  );
  assert.equal(read.isError, false, read.content);
  assert.equal(JSON.parse(read.content).output, 'new output');
  const stopped = await tools.execute(
    { id: 'stop', name: 'job_kill', arguments: { id: 'cmd-1' } },
    ctx(registry),
  );
  assert.equal(stopped.isError, false, stopped.content);
  assert.match(stopped.content, /Stopped cmd-1 \(npm test\); it is now cancelled/);
});
test('the registry refuses an ambiguous or unknown id instead of guessing', async (t) => {
  const directory = await root(t);
  const tools = createTools(directory, undefined, 'session-a');
  t.after(() => tools.close());
  const registry = new JobRegistry();
  registry.register(fake('command', [snapshot({ id: 'both', kind: 'command' })]));
  registry.register(fake('subagent', [snapshot({ id: 'both', kind: 'subagent' })]));
  // Two producers claiming one id would make `job_output` read a different job than `job_list` showed.
  assert.throws(() => registry.list('session-a'), /claimed by more than one producer/);
  const unknown = await tools.execute(
    { id: 'read', name: 'job_output', arguments: { id: 'nobody' } },
    ctx(registry),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown job "nobody"/);
  assert.match(unknown.content, /job_list/, 'the refusal has to say how to find a real id');
});
test('a second producer of the same kind is refused at registration', () => {
  const registry = new JobRegistry();
  registry.register(fake('command', []));
  assert.throws(() => registry.register(fake('command', [])), /already registered/);
  // The other kind is still free, which is what makes the check a kind check rather than a single slot.
  assert.doesNotThrow(() => registry.register(fake('subagent', [])));
});
test('a job is reachable only from the session that owns it', () => {
  const registry = new JobRegistry();
  registry.register(fake('command', [snapshot({ id: 'cmd-1', kind: 'command' })]));
  assert.equal(registry.list('session-b').length, 0);
  assert.throws(
    () => registry.output({ id: 'cmd-1', scope: 'session-b', cursor: 0, waitMs: 0 }),
    /Unknown job/,
  );
});
test('command jobs are read and stopped through the unified surface, in their own scope', async (t) => {
  const directory = await root(t);
  await writeFile(
    path.join(directory, 'wait.cjs'),
    'require("fs").writeFileSync("job-pid.txt",String(process.pid));console.log("WAITING");setInterval(()=>{},1000);',
  );
  const tools = createTools(directory, undefined, 'session-a');
  const other = createTools(directory, undefined, 'session-b');
  t.after(async () => {
    await tools.close();
    await other.close();
  });
  const started = await tools.execute(
    { id: 'start', name: 'start_command', arguments: { command: 'node wait.cjs' } },
    ctx(),
  );
  assert.equal(started.isError, false, started.content);
  const { id } = JSON.parse(started.content);
  const listed = await tools.execute({ id: 'l', name: 'job_list', arguments: {} }, ctx());
  assert.match(listed.content, new RegExp(`${id} \\[command\\]`));
  assert.match(listed.content, /WAITING|node wait\.cjs/, 'the label has to identify the job');
  // Another session's registry cannot see it, let alone stop it.
  const foreign = await other.execute({ id: 'f', name: 'job_kill', arguments: { id } }, ctx());
  assert.equal(foreign.isError, true);
  assert.match(foreign.content, /Unknown job/);
  const killed = await tools.execute({ id: 'k', name: 'job_kill', arguments: { id } }, ctx());
  assert.equal(killed.isError, false, killed.content);
  assert.match(killed.content, /Stopped/);
  // Stopping what is already stopped reports the final state, like any other idempotent control.
  const again = await tools.execute({ id: 'k2', name: 'job_kill', arguments: { id } }, ctx());
  assert.equal(again.isError, false, again.content);
  assert.equal(JSON.parse(again.content.split('\n').slice(1).join('\n')).status, 'cancelled');
});
