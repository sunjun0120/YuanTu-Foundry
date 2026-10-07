/**
 * The structured half of a tool result, from the declaration to the client's snapshot.
 *
 * Long enough, the transcript could only be printed: `ToolResult` was text, so the desktop stringified the
 * *arguments* into a `<pre>` and every result was prose, whatever it was. What has to hold now is the whole
 * path, and each test here pins one link of it:
 *
 * - a tool **declares** the shape of its result once, and that declaration is JSON Schema the registry's own
 *   Ajv compiles — the same discipline the tool's *input* schema already lives under;
 * - the three read-only tools actually **produce** a value matching their declaration, with `content`
 *   untouched, because the model still reads the text form and changing it would change model behaviour;
 * - the renderer name is a member of **one closed set**, and the source names no other;
 * - the name and the value **reach the client**, on the tool message the session controller projects, so a
 *   carrier can dispatch a card without a second read of anything;
 * - **absence** means exactly one thing — no structured payload — and is what a tool with no contract (or a
 *   call that never produced a value) looks like.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import { TOOL_RENDERERS } from '../packages/protocol/tool-result.ts';
import { commandTool } from '../packages/tools/command.ts';
import { fileTools } from '../packages/tools/files.ts';
import type {
  AgentEvent,
  RunResult,
  Tool,
  ToolContext,
  ToolResult,
} from '../packages/protocol/index.ts';
import { projectRoot } from './process-fixture.ts';

/**
 * The Ajv the registry compiles tool *input* schemas with, used here on the *output* declarations.
 *
 * The same options on purpose: `strict: true` is what makes "the contract is JSON Schema" a checked claim
 * rather than a naming convention, so a declaration that is really a Zod object or uses a keyword Ajv does not
 * know fails here instead of at whatever client tries to interpret it.
 */
const ajv = new Ajv({ allErrors: true, strict: true });

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function toolNamed(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} is not in the tool set`);
  return tool;
}
/**
 * One result, checked against the contract its own tool declared.
 *
 * Every assertion here is one a client would otherwise have to make for itself and could not: that the tool
 * declared anything at all, that the result's renderer is the one the declaration names, and that the value
 * satisfies the schema. A tool that got any of this wrong would be a defect the UI could only show as an empty
 * card, which is why it is caught here.
 */
function payload(tool: Tool, result: ToolResult): Record<string, unknown> {
  const contract = tool.output;
  assert.ok(contract, `${tool.name} declares an output contract`);
  assert.equal(contract.schema.type, 'object', `${tool.name}: the payload is an object`);
  assert.equal(
    contract.schema.additionalProperties,
    false,
    `${tool.name}: the contract is closed, so a field a card does not expect cannot appear`,
  );
  assert.ok(result.output, `${tool.name} answers a successful call with a payload`);
  assert.equal(
    result.output.render,
    contract.render,
    `${tool.name} names the renderer its declaration names`,
  );
  const validate = ajv.compile(contract.schema);
  assert.ok(
    validate(result.output.value),
    `${tool.name}: ${ajv.errorsText(validate.errors)} (${JSON.stringify(result.output.value)})`,
  );
  return result.output.value as Record<string, unknown>;
}

test('read_file publishes the slice it read, without changing the text form', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src.ts'), 'one\ntwo\nthree\nfour\n');
  const tool = toolNamed(fileTools(root), 'read_file');
  const result = await tool.execute({ path: 'src.ts', start_line: 2, end_line: 3 }, context());
  // The model's half is byte-for-byte what it always was: numbered lines, nothing else. `src.ts` ends in a
  // newline, so that form numbers one empty line past the end — the payload's `totalLines` does not count that
  // split artifact, which is what keeps "lines 2–3 of 4" a true sentence about a four-line file.
  assert.equal(result.content, '2: two\n3: three');
  const value = payload(tool, result);
  assert.deepEqual(value, {
    path: 'src.ts',
    language: 'typescript',
    startLine: 2,
    endLine: 3,
    totalLines: 4,
    // The raw lines, so a card draws its own gutter starting at `startLine` instead of re-parsing `2: two`.
    text: 'two\nthree',
    truncated: false,
  });
  // The whole file, when no range is asked for: endLine is the last line actually returned, not the last one
  // requested — a window presented as the whole file is the failure this field exists to prevent.
  const whole = payload(tool, await tool.execute({ path: 'src.ts' }, context()));
  assert.deepEqual(
    [whole.startLine, whole.endLine, whole.totalLines],
    [1, 4, 4],
    'a read with no range covers the file and says how long it is',
  );
  // A file with no extension gets no language rather than a guess: a wrong highlight is worse than none.
  await writeFile(path.join(root, 'Makefile'), 'all:\n\techo hi\n');
  const plain = payload(tool, await tool.execute({ path: 'Makefile' }, context()));
  assert.equal(plain.language, undefined);
});

test('search_files publishes the same matches the text form lists, in both modes', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'alpha\nbeta needle\ngamma\n');
  await writeFile(path.join(root, 'b.txt'), 'needle delta\n');
  const tool = toolNamed(fileTools(root), 'search_files');
  const expected = [
    { path: 'a.txt', line: 2, text: 'beta needle' },
    { path: 'b.txt', line: 1, text: 'needle delta' },
  ];
  const literal = await tool.execute({ query: 'needle' }, context());
  assert.equal(literal.content, 'a.txt:2: beta needle\nb.txt:1: needle delta');
  assert.deepEqual(payload(tool, literal), {
    query: 'needle',
    mode: 'literal',
    matches: expected,
    limited: false,
  });
  /**
   * The regular-expression path runs in a worker and used to hand back formatted lines, which the tool printed
   * as they were. It now hands back the matches themselves, so the two modes cannot grow two ideas of what a
   * match is — and the text form is still identical, which is what this asserts.
   */
  const regex = await tool.execute({ query: 'n[e]edle', mode: 'regex' }, context());
  assert.equal(regex.content, literal.content);
  assert.deepEqual(payload(tool, regex), {
    query: 'n[e]edle',
    mode: 'regex',
    matches: expected,
    limited: false,
  });
  const none = await tool.execute({ query: 'nothing-here' }, context());
  assert.equal(none.content, 'No matches');
  assert.deepEqual(payload(tool, none), {
    query: 'nothing-here',
    mode: 'literal',
    matches: [],
    limited: false,
  });
});

test('search_files reports a cut list as limited, and keeps the text form it always had', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'needle one\nneedle two\n');
  const tool = toolNamed(fileTools(root), 'search_files');
  const limited = await tool.execute({ query: 'needle', max_results: 1 }, context());
  assert.equal(limited.content, 'a.txt:1: needle one\n[match limit reached]');
  assert.deepEqual(payload(tool, limited), {
    query: 'needle',
    mode: 'literal',
    matches: [{ path: 'a.txt', line: 1, text: 'needle one' }],
    limited: true,
  });
  /**
   * A matched line longer than the display cap: the text form cuts it and appends the marker it has always
   * appended, while the payload carries the line itself, because a `[output truncated]` marker is presentation
   * and a card that showed one would be showing a file that does not exist.
   */
  const long = 'x'.repeat(600) + 'NEEDLE';
  await writeFile(path.join(root, 'long.txt'), `${long}\n`);
  const cut = await tool.execute({ query: 'NEEDLE' }, context());
  assert.equal(cut.content, `long.txt:1: ${'x'.repeat(500)}\n[output truncated]`);
  const value = payload(tool, cut) as { matches: { text: string }[] };
  assert.equal(value.matches[0]!.text, 'x'.repeat(500));
});

test('run_command publishes both streams, the exit code and how long it took', async (t) => {
  const root = await workspace(t);
  // A file rather than an inline `-e` program: the command line is built by whichever shell the sandbox picks,
  // and quoting a program through two levels of it is how a test starts failing for a reason it is not about.
  await writeFile(
    path.join(root, 'both.cjs'),
    "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exit(3);\n",
  );
  const tool = commandTool(root);
  const result = await tool.execute({ command: 'node both.cjs' }, context());
  // A non-zero exit is a failed call and still a result with a shape: this is exactly when a card wants to show
  // the streams, so a payload only on success would hide the command output a person opens the card to read.
  assert.equal(result.isError, true);
  const text = JSON.parse(result.content) as { exitCode: number; output: string };
  assert.equal(text.exitCode, 3);
  assert.equal(text.output, 'out\nerr\n');
  const value = payload(tool, result);
  assert.equal(value.command, 'node both.cjs');
  assert.equal(value.exitCode, 3);
  assert.equal(value.signal, null);
  assert.equal(value.timedOut, false);
  // The two streams are what the merged text cannot say: which line came from where, which is what a card
  // colours and what a person reads first when a command fails.
  assert.equal(value.stdout, 'out\n');
  assert.equal(value.stderr, 'err\n');
  assert.equal(value.truncated, false);
  assert.ok(typeof value.durationMs === 'number' && value.durationMs >= 0);
});

test('the closed set of renderer names is exactly what the tools declare', async (t) => {
  const root = await workspace(t);
  const tools = [...fileTools(root), commandTool(root)];
  const declared = tools
    .filter((tool) => tool.output)
    .map((tool) => [tool.name, tool.output!.render] as const);
  /**
   * The list is written out rather than derived, so adding a fourth structured tool is a deliberate edit here:
   * a card is dispatched by the renderer name, and a new name that no carrier implements is a card nobody can
   * draw — the failure this assertion turns into a test failure instead of a blank panel.
   */
  assert.deepEqual(declared, [
    ['read_file', 'file-read'],
    ['search_files', 'search-results'],
    ['run_command', 'command-output'],
  ]);
  assert.deepEqual(
    declared.map(([, render]) => render).sort(),
    [...TOOL_RENDERERS].sort(),
    'every name in the closed set is produced by some tool, and no tool produces one outside it',
  );
  // A declaration with no schema, or a schema that is not an object, would validate anything a tool returned.
  for (const tool of tools) {
    if (!tool.output) continue;
    assert.ok(
      Object.keys(tool.output.schema.properties as object).length > 0,
      `${tool.name} declares the fields of its payload`,
    );
  }
});

test('no tool in the repository names a renderer outside the closed set', async () => {
  /**
   * A source scan, and deliberately not a scan of the tools this test can build.
   *
   * `ToolRegistry` has no way to enumerate its entries, so a runtime check can only see the tools a test
   * constructs — and the tool that would get this wrong is the one nobody thought to construct here: an
   * extension's tool, or one added to a module this test does not import. `render:` is reserved for this
   * contract, so the literal appearing anywhere in the tool code is a renderer name, and the set of them must
   * be the set the protocol declares. If a future use of `render:` means something else, this is where that
   * gets a different key word rather than a quiet exception.
   */
  const root = path.join(projectRoot, 'packages');
  const named = new Set<string>();
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const text = await readFile(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/\brender:\s*'([^']+)'/g)) named.add(match[1]!);
  }
  assert.deepEqual(
    [...named].sort(),
    [...TOOL_RENDERERS].sort(),
    'the renderer names written in the source are the ones the protocol declares',
  );
});

/**
 * A hand-driven client: what is being tested is one projection, and a Host process would only make it harder
 * to see. Modelled on the fixture `tests/client.test.ts` uses for the same reason.
 */
class ProjectionClient {
  status = 'ready';
  readonly events = new Set<(event: AgentEvent) => void>();
  settle!: (result: RunResult) => void;
  private pending = new Promise<RunResult>((resolve) => {
    this.settle = resolve;
  });
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  subscribeStatus(): () => void {
    return () => {};
  }
  run(): Promise<RunResult> {
    return this.pending;
  }
  async request(method: string): Promise<unknown> {
    if (method === 'session.get')
      return {
        session: { id: 's1', workspace: '.', createdAt: '', activeRun: null },
        messages: [],
      };
    if (method === 'plan.get') return null;
    if (method === 'subagents.list') return [];
    if (method === 'changes.list') return [];
    if (method === 'background.list') return [];
    if (method === 'task.list') return [];
    return {};
  }
  emit(event: Omit<AgentEvent, 'seq'>): void {
    for (const listener of this.events) listener({ ...event, seq: 0 });
  }
}

test('a live tool result reaches the client snapshot with its payload and renderer name', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const client = new ProjectionClient();
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('s1');
  const sending = controller.send('go');
  client.emit({ type: 'run.started', sessionId: 's1', runId: 'r1', data: {} });
  /**
   * The event is built exactly the way the run builds it — the whole tool result spread into `data` — so this
   * fails if the run stops carrying the payload, not just if the projection stops reading it.
   */
  const tool = toolNamed(fileTools(root), 'read_file');
  const result = await tool.execute({ path: 'a.txt' }, context());
  client.emit({
    type: 'tool.finished',
    sessionId: 's1',
    runId: 'r1',
    data: { callId: 'c1', ...result },
  });
  const message = controller.snapshot.messages.at(-1);
  if (message?.role !== 'tool') assert.fail('the tool result is projected into the transcript');
  // The field path a carrier reads: `snapshot.messages[i].output`, on the message whose role is `tool`.
  assert.equal(message.output?.render, 'file-read');
  assert.deepEqual(message.output?.value, {
    path: 'a.txt',
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    text: 'alpha',
    truncated: false,
  });
  // The text form is still there beside the payload, and still numbers the line a trailing newline splits off.
  assert.equal(message.content, '1: alpha\n2: ');
  /**
   * A tool with no contract, and a call that produced no value, look the same on the message — and that is the
   * point: absence has one meaning, "render the text", so a carrier never has to guess whether a card was
   * supposed to exist before falling back.
   */
  client.emit({
    type: 'tool.finished',
    sessionId: 's1',
    runId: 'r1',
    data: { callId: 'c2', content: 'plain result', isError: false },
  });
  const plain = controller.snapshot.messages.at(-1);
  if (plain?.role !== 'tool') assert.fail('the second result is projected too');
  assert.equal(plain.output, undefined);
  client.settle({
    runId: 'r1',
    sessionId: 's1',
    status: 'completed',
    text: 'done',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.equal((await sending).status, 'completed');
});
