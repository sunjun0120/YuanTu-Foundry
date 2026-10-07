/**
 * Declaring deliverables.
 *
 * `present` is the one place a run says "these files are the output" rather than naming paths in prose. What
 * these tests pin is what makes the declaration worth recording: it verifies before it writes, so a missing or
 * empty file is refused and a call that names three files presents all three or none; the durable event carries
 * every file the call named, so the panel's update and the log line are one fact; and the list folds a repeated
 * path in place rather than growing a second entry for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { deliverablesProjection } from '../packages/storage/projections.ts';
import { SESSION_EVENT_TYPES } from '../packages/storage/events.ts';
import { AGENT_EVENT_TYPES } from '../packages/protocol/index.ts';
import { presentFiles } from '../packages/protocol/deliverables.ts';
import type { PresentedFile } from '../packages/protocol/deliverables.ts';
import type {
  AgentEvent,
  ModelResponse,
  Provider,
  ToolContext,
} from '../packages/protocol/index.ts';

const reply = (text: string): ModelResponse => ({
  text,
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});
const context = (deliverables?: ToolContext['deliverables']): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  ...(deliverables ? { deliverables } : {}),
});
async function workspace(t: test.TestContext, name = 'yuantu-present-') {
  const root = await mkdtemp(path.join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('present is declared, carries no permission, and survives a read-only run', async (t) => {
  const root = await workspace(t);
  const tools = createTools(root);
  t.after(() => tools.close());
  const spec = tools.specs().find((entry) => entry.name === 'present');
  assert.ok(spec, 'present must be registered');
  assert.ok(
    tools.specs({ readOnly: true }).some((entry) => entry.name === 'present'),
    'a planning run may point at the files it is proposing to change — which it cannot do if it declared a permission',
  );
  assert.ok(SESSION_EVENT_TYPES.includes('deliverable.presented'));
  assert.ok(AGENT_EVENT_TYPES.includes('deliverable.presented'));
});
test('a presented file is verified, recorded once, and announced on the live channel', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'report.md'), '# Findings\n\nAll good.\n');
  const tools = createTools(root);
  t.after(() => tools.close());
  const written: PresentedFile[][] = [];
  const result = await tools.execute(
    call('present', { files: [{ path: 'report.md', description: 'The findings' }] }),
    context({
      read: () => [],
      write: (files) => {
        written.push([...files]);
      },
    }),
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(written.length, 1);
  const [file] = written[0]!;
  assert.equal(file?.path, 'report.md');
  assert.equal(file?.description, 'The findings');
  assert.equal(file?.bytes, Buffer.byteLength('# Findings\n\nAll good.\n'));
  // The digest is the one `verify_file_delivery` establishes, so the two tools cannot disagree about it.
  assert.match(String(file?.sha256), /^[a-f0-9]{64}$/);
  assert.ok(result.content.includes('report.md'));
});
test('a call that names one missing file presents nothing at all', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'first.txt'), 'first\n');
  const tools = createTools(root);
  t.after(() => tools.close());
  const written: PresentedFile[][] = [];
  const result = await tools.execute(
    call('present', {
      files: [{ path: 'first.txt' }, { path: 'second.txt' }],
    }),
    context({
      read: () => [],
      write: (files) => {
        written.push([...files]);
      },
    }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /second\.txt/);
  assert.deepEqual(written, [], 'the first file must not be left declared by a failed call');
});
test('an empty file is refused: a deliverable that cannot be opened is not one', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'empty.txt'), '');
  const tools = createTools(root);
  t.after(() => tools.close());
  const result = await tools.execute(
    call('present', { files: [{ path: 'empty.txt' }] }),
    context({ read: () => [], write: () => {} }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Nothing was presented/);
});
test('a path outside the workspace is refused', async (t) => {
  const root = await workspace(t);
  const tools = createTools(root);
  t.after(() => tools.close());
  const result = await tools.execute(
    call('present', { files: [{ path: '../outside.txt' }] }),
    context({ read: () => [], write: () => {} }),
  );
  assert.equal(result.isError, true);
});
test('the same path listed twice in one call is refused rather than presented twice', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'one.txt'), 'one\n');
  const tools = createTools(root);
  t.after(() => tools.close());
  const result = await tools.execute(
    call('present', { files: [{ path: 'one.txt' }, { path: 'one.txt' }] }),
    context({ read: () => [], write: () => {} }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /more than once/);
});
test('a run with no deliverable seam is told so instead of failing silently', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'file.txt'), 'content\n');
  const tools = createTools(root);
  t.after(() => tools.close());
  const result = await tools.execute(call('present', { files: [{ path: 'file.txt' }] }), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /No deliverable list is wired into this run/);
});
test('presenting one path twice replaces it in place', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-present-fold-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  // One teardown, in one order: the store has to be closed before the directory holding it can go.
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  await writeFile(path.join(root, 'b.txt'), 'b\n');
  const session = store.create(root);
  let step = 0;
  const provider: Provider = {
    async complete() {
      step++;
      if (step === 1)
        return toolCall('c1', 'present', { files: [{ path: 'a.txt', description: 'first' }] });
      if (step === 2) return toolCall('c2', 'present', { files: [{ path: 'b.txt' }] });
      if (step === 3)
        return toolCall('c3', 'present', {
          files: [{ path: 'a.txt', description: 'revised' }],
        });
      return reply('Done.');
    },
  };
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  await agent.run({ sessionId: session.id, prompt: 'Produce the files' });
  const files = store.deliverables(session.id);
  assert.deepEqual(
    files.map((file) => file.path),
    ['a.txt', 'b.txt'],
    'a repeated path keeps its place in the list',
  );
  assert.equal(
    files[0]?.description,
    'revised',
    'the newest declaration for a path is the one kept',
  );
  // The fold and the writer are one function, so a reloaded panel shows the same list a live one did.
  assert.deepEqual(
    store.stateOf<PresentedFile[]>('deliverables', session.id),
    deliverablesProjection.apply(deliverablesProjection.initial(), {
      seq: 0,
      sessionId: session.id,
      type: 'deliverable.presented',
      at: '',
      data: { files },
    }),
  );
  assert.equal(
    events.filter((event) => event.type === 'deliverable.presented').length,
    3,
    'every accepted call is announced once',
  );
});
test('presentFiles is a replacement, and the list stays bounded', () => {
  const make = (name: string, at: string): PresentedFile => ({
    path: name,
    bytes: 1,
    sha256: 'a'.repeat(64),
    at,
  });
  const once = presentFiles([], [make('a', '1'), make('b', '2')]);
  assert.deepEqual(
    presentFiles(once, [make('a', '3')]).map((file) => file.at),
    ['3', '2'],
  );
  const many = Array.from({ length: 60 }, (_, index) => make(`f${index}`, String(index)));
  const bounded = presentFiles([], many);
  assert.equal(bounded.length, 40);
  assert.equal(bounded.at(-1)?.path, 'f59', 'the oldest declarations drop off first');
});
