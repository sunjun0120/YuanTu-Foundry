/**
 * `run_code`: a program the model writes, running with the run's own tools.
 *
 * The interesting property is not "code runs" — it is that a program is *not* a privileged path: an inner write is
 * approved by the same person, refused by the same gates and stopped by the same deadline as a call the model made
 * directly. So most of what is asserted below is that the ordinary machinery still applies inside a program, plus
 * the two things that make a program safe to offer at all: it cannot reach a tool the run does not have, and it
 * cannot reach the machine (no `process`, no `require`, no string code generation).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createTools } from '../packages/tools/index.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { MAX_TOOL_OUTPUT, ToolRegistry } from '../packages/tools/registry.ts';
import { RUN_CODE, toolMode, toolSdk } from '../packages/tools/run-code.ts';
import { TOOL_TIMEOUT_MARKER } from '../packages/tools/timeouts.ts';
import { FS_NOT_OBSERVED } from '../packages/tools/fs-observation.ts';
import { projectRoot } from './process-fixture.ts';
import type {
  AgentEvent,
  Approval,
  Provider,
  Tool,
  ToolCatalog,
  ToolContext,
} from '../packages/protocol/index.ts';

/** A real 1×1 PNG, so `read_image` accepts it (see `tests/tool-images.test.ts`). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function workspaceFixture(
  t: test.TestContext,
): Promise<{ root: string; tools: ToolRegistry; context: ToolContext }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-run-code-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'alpha.txt'), 'first\nsecond\n');
  await writeFile(path.join(root, 'beta.txt'), 'third\n');
  return {
    root,
    tools: createTools(root),
    context: { signal: new AbortController().signal, approve: async () => true },
  };
}

test('CJS consumers of the tool registry do not pull in ESM-only worker location code', async () => {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ['packages/tools/registry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    logLevel: 'silent',
  });
  assert.deepEqual(result.warnings, []);
});

/**
 * The catalog a run supplies, reproduced for a test.
 *
 * `invoke` goes through the registry, which is the whole design claim: an inner call and an outer call are the same
 * call as far as validation, permission, approval and journalling are concerned.
 */
function catalogFor(
  tools: ToolRegistry,
  context: ToolContext,
  options: { readOnly?: boolean; parallelLimit?: number } = {},
): ToolCatalog {
  return {
    specs: tools.specs({ ...options, mode: 'native' }),
    invoke: (inner) => tools.execute(inner, context),
    // The registry's own classification and the run's own width, exactly as the kernel supplies them: a stub that
    // guessed here would test a scheduler the product does not have.
    mode: (inner) => tools.executionMode(inner),
    parallelLimit: options.parallelLimit ?? 4,
  };
}

/** Runs a program with the catalog this run would have handed it. */
async function runProgram(
  tools: ToolRegistry,
  context: ToolContext,
  code: string,
  catalog?: ToolCatalog,
): Promise<{ content: string; isError: boolean }> {
  const result = await tools.execute(
    { id: 'program', name: RUN_CODE, arguments: { code } },
    { ...context, catalog: catalog ?? catalogFor(tools, context) },
  );
  return { content: result.content, isError: result.isError };
}

test('one program call does the work of several tool calls', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    [
      "const a = await tools.read_file({ path: 'alpha.txt' });",
      "const b = await tools.read_file({ path: 'beta.txt' });",
      "return a.includes('second') && b.includes('third') ? 'both read' : 'missing';",
    ].join('\n'),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^both read/);
  // The model asked for one call and the run made three: the program call and its two reads.
  assert.match(result.content, /\[tools\] 2 call\(s\) in \d+ms: read_file, read_file/);
});

for (const code of ["return require('node:fs');", "return await import('node:fs');"]) {
  test(`unsupported module loading gives a tool SDK recovery path: ${code}`, async (t) => {
    const { tools, context } = await workspaceFixture(t);
    const refused = await runProgram(tools, context, code);
    assert.equal(refused.isError, true);
    assert.match(refused.content, /tools\.read_file/);
    const recovered = await runProgram(
      tools,
      context,
      "return await tools.read_file({path:'alpha.txt'});",
    );
    assert.equal(recovered.isError, false);
    assert.match(recovered.content, /first[\s\S]*second/);
  });
}

test('unsupported console formatting points to a supported logging and return path', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const refused = await runProgram(
    tools,
    context,
    "console.table([await tools.read_file({path:'alpha.txt'})]);",
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /console\.log/);
  const recovered = await runProgram(
    tools,
    context,
    "const text=await tools.read_file({path:'alpha.txt'}); console.log(text); return [text];",
  );
  assert.equal(recovered.isError, false);
  assert.match(recovered.content, /first[\s\S]*second/);
});

test('an inner call is approved exactly as an outer one would be', async (t) => {
  const { root, tools } = await workspaceFixture(t);
  const approvals: Approval[] = [];
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async (approval) => {
      approvals.push(approval);
      return true;
    },
  };
  const result = await runProgram(
    tools,
    context,
    [
      "await tools.read_file({ path: 'alpha.txt' });",
      "await tools.edit_file({ path: 'alpha.txt', old_text: 'second', new_text: 'SECOND' });",
      "return 'edited';",
    ].join('\n'),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^edited/);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.toolCall.name, 'edit_file');
  // The inner id is derived from the outer one, so an approval record names the program it came from. A run
  // supplies the model's call id; this bare registry has none, so the tool's own name is the fallback.
  assert.equal(approvals[0]!.toolCall.id, 'run_code#2');
  assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), 'first\nSECOND\n');
});

test('a gate that refuses an inner call fires before the approval prompt', async (t) => {
  const { root, tools } = await workspaceFixture(t);
  let approvals = 0;
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => {
      approvals += 1;
      return true;
    },
  };
  // The read-before-write gate is an *input* check, so the program cannot use a write to obtain a change this run
  // never looked at — and the person is never shown a diff for it.
  const result = await runProgram(
    tools,
    context,
    [
      'let failure = "";',
      'try {',
      "  await tools.edit_file({ path: 'alpha.txt', old_text: 'first', new_text: 'FIRST' });",
      '} catch (error) { failure = error.message; }',
      'return failure;',
    ].join('\n'),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
  assert.equal(approvals, 0);
  assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), 'first\nsecond\n');
});

test('a denied inner call throws inside the program, and the program can handle it', async (t) => {
  const { root, tools } = await workspaceFixture(t);
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => false,
  };
  const result = await runProgram(
    tools,
    context,
    [
      "await tools.read_file({ path: 'alpha.txt' });",
      'try {',
      "  await tools.edit_file({ path: 'alpha.txt', old_text: 'first', new_text: 'FIRST' });",
      "  return 'edited';",
      '} catch (error) {',
      '  return `refused: ${error.message}`;',
      '}',
    ].join('\n'),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^refused: Permission denied by user/);
  assert.equal(await readFile(path.join(root, 'alpha.txt'), 'utf8'), 'first\nsecond\n');
});

test('a read-only catalog offers the program no way to write', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    'return typeof tools.write_file;',
    catalogFor(tools, context, { readOnly: true }),
  );
  assert.equal(result.isError, false);
  // Not "denied" but "absent": a read-only run's program is handed the read-only catalog, so the capability is not
  // there to be denied.
  assert.match(result.content, /^undefined/);
});

test('a program that throws reports what it had already done', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    [
      "await tools.read_file({ path: 'alpha.txt' });",
      "await tools.read_file({ path: 'missing.txt' });",
      "return 'unreachable';",
    ].join('\n'),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /run_code failed:/);
  assert.match(result.content, /missing\.txt/);
  // The trace is the difference between "the program failed" and "it failed on the second call, which returned
  // this" — without it a failure inside a program is unreadable.
  assert.match(result.content, /\[tools\] 2 call\(s\) before the failure/);
  assert.match(result.content, /read_file\(\{"path":"alpha\.txt"\}\) -> 1: first/);
  assert.match(result.content, /read_file\(\{"path":"missing\.txt"\}\) -> failed:/);
});

test('console output comes back with the answer', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    ["console.log('working', 1, 2);", "console.error('careful');", "return 'done';"].join('\n'),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^done/);
  assert.match(result.content, /\[console\]\nworking 1 2\ncareful/);
});

test('the program has no machine behind it', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    'return [typeof process, typeof require, typeof fetch, typeof Buffer].join(",");',
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^undefined,undefined,undefined,undefined/);
});

test('the program cannot generate code from strings', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(tools, context, "return eval('1 + 1');");
  assert.equal(result.isError, true);
  assert.match(result.content, /code generation/i);
});

test('a program cannot start another program', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(tools, context, 'return typeof tools.run_code;');
  assert.equal(result.isError, false);
  assert.match(result.content, /^undefined/);
});

test('a program that never returns is stopped by the call deadline', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  tools.deadlines = { defaultMs: 400 };
  const started = Date.now();
  const result = await runProgram(tools, context, 'while (true) {}');
  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(TOOL_TIMEOUT_MARKER));
  // The worker died with the call; the run is not left holding a thread that is still spinning.
  assert.ok(Date.now() - started < 20_000, 'the deadline did not end the call');
});

test('cancellation ends the program instead of being reported as a tool failure', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('run cancelled')), 200);
  await assert.rejects(
    runProgram(tools, { ...context, signal: controller.signal }, 'while (true) {}'),
    /run cancelled/,
  );
});

test('a program that allocates without bound dies as a failed call, not as the host', async (t) => {
  /**
   * The guest runs in a worker thread, and a worker created without `resourceLimits` inherits the *process's* heap:
   * a program that allocates without bound therefore does not fail, it takes the host down with it — the session
   * store, the run in flight, every other session in the process. The ceiling `guestResourceLimits` sets is what
   * makes "the program died" true instead of "everything died", and this is the test that says it is enforced
   * rather than merely passed to the constructor.
   */
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(
    tools,
    context,
    'const kept = [];\nfor (;;) kept.push(new Array(1_000_000).fill(0));',
  );
  assert.equal(result.isError, true);
  /**
   * The message is the mechanism, not just a symptom: "reaching memory limit" is what Node says when a worker
   * crosses its `resourceLimits`. A plain out-of-memory would read differently — and, without the ceiling, would be
   * the process's own heap being exhausted rather than the guest's, which is the failure this test exists to
   * prevent.
   */
  assert.match(
    result.content,
    /reaching memory limit/i,
    `the call failed because the guest hit its ceiling: ${result.content.slice(0, 200)}`,
  );
});

/** A tool that takes a known time and counts how many of its kind are in flight, so overlap is observable. */
function timedTool(
  name: string,
  timeline: {
    events: string[];
    parallel: number;
    exclusive: number;
    peakParallel: number;
    peakExclusive: number;
  },
  permission?: 'write',
): Tool {
  return {
    name,
    ...(permission ? { permission } : { isConcurrencySafe: () => !permission }),
    description: `Test tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 0 } },
      required: ['ms'],
      additionalProperties: false,
    },
    async execute(args: { ms: number }) {
      const bucket = permission ? 'exclusive' : 'parallel';
      timeline[bucket]++;
      timeline[bucket === 'exclusive' ? 'peakExclusive' : 'peakParallel'] = Math.max(
        timeline[bucket === 'exclusive' ? 'peakExclusive' : 'peakParallel'],
        timeline[bucket],
      );
      timeline.events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, args.ms));
      timeline.events.push(`end ${name}`);
      timeline[bucket]--;
      return { isError: false, content: `${name} slept ${args.ms}ms` };
    },
  };
}

test('a program cannot overlap what the model’s own batch would run one at a time', async (t) => {
  /**
   * The inner path was the one place two permission-bearing calls could be in flight together: the worker's
   * message handler started every call as it arrived, so `Promise.all([tools.write_a(...), tools.write_b(...)])`
   * had two approvals pending and two effect-journal entries interleaved — exactly what `executionMode` refuses
   * for the model's own batches, and it is fail-closed about it (a permission-bearing tool may not overlap a
   * sibling, and neither may one that declares no classifier).
   *
   * `catalog.mode` and `catalog.parallelLimit` now carry the registry's classification and the run's own width
   * into the guest, where the calls actually start. Both halves are asserted, because serializing everything
   * would also make the first one true: an exclusive call runs alone, and parallel ones still overlap.
   */
  const { tools, context } = await workspaceFixture(t);
  const timeline = {
    events: [] as string[],
    parallel: 0,
    exclusive: 0,
    peakParallel: 0,
    peakExclusive: 0,
  };
  tools.register(timedTool('read_one', timeline));
  tools.register(timedTool('read_two', timeline));
  tools.register(timedTool('write_one', timeline, 'write'));
  const catalog = catalogFor(tools, context, { parallelLimit: 2 });

  const result = await runProgram(
    tools,
    context,
    [
      // An exclusive call and a read that arrive together: the read waits for the pool the write took whole.
      'await Promise.all([tools.write_one({ ms: 30 }), tools.read_one({ ms: 30 })]);',
      // Two reads, which the run would overlap: the guest keeps that.
      'await Promise.all([tools.read_one({ ms: 30 }), tools.read_two({ ms: 30 })]);',
      // Two writes, which the run would serialize: so does the guest, one at a time.
      'await Promise.all([tools.write_one({ ms: 20 }), tools.write_one({ ms: 20 })]);',
      "return 'done';",
    ].join('\n'),
    catalog,
  );

  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /done/);
  assert.equal(timeline.peakExclusive, 1, 'no two exclusive calls were ever in flight together');
  assert.equal(timeline.peakParallel, 2, 'and parallel calls still overlap, up to the run’s width');
  assert.deepEqual(timeline.events.slice(0, 2), ['start write_one', 'end write_one']);
  assert.deepEqual(timeline.events.slice(2, 4), ['start read_one', 'end read_one']);
  assert.deepEqual(timeline.events.slice(4), [
    'start read_one',
    'start read_two',
    'end read_one',
    'end read_two',
    'start write_one',
    'end write_one',
    'start write_one',
    'end write_one',
  ]);
});

test('a result too large to return is bounded like any other tool result', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await runProgram(tools, context, "return 'x'.repeat(60000);");
  assert.equal(result.isError, false);
  assert.ok(result.content.length <= MAX_TOOL_OUTPUT + 64, String(result.content.length));
  assert.match(result.content, /\[output truncated\]/);
});

test("a picture a program's tool returned is reported, not silently dropped", async (t) => {
  const { root, tools, context } = await workspaceFixture(t);
  await writeFile(path.join(root, 'shot.png'), PNG);
  const result = await runProgram(
    tools,
    context,
    "return await tools.read_image({ path: 'shot.png' });",
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /not visible inside a program; call read_image directly/);
});

test('the declaration list names every tool a program can call, and no others', () => {
  const tools = createTools(process.cwd());
  const native = tools.specs({ mode: 'native' });
  const sdk = toolSdk(native);
  assert.match(sdk, /tools\.read_file\(\{ path: string/);
  assert.match(sdk, /tools\.search_files\(\{ query: string/);
  // Optional parameters are marked, which is the one thing a JSON schema said and a declaration still can.
  assert.match(sdk, /tools\.read_file\(\{ path: string, start_line\?: number/);
  // The tool that runs the program is not offered inside it (and neither is anything not in this registry).
  assert.doesNotMatch(sdk, /tools\.run_code\(/);
  assert.equal(sdk.split('\n').length, native.length - 1);
});

test('folding the catalog sends one schema and keeps the tools reachable', () => {
  const tools = createTools(process.cwd());
  const native = tools.specs({ mode: 'native' });
  tools.toolMode = 'ptc';
  const folded = tools.specs();
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.name, RUN_CODE);
  assert.match(folded[0]!.description, /tools\.read_file\(\{ path: string/);
  // The lever, stated as a measurement: the schema cost of the catalog is what folding is for.
  assert.ok(
    JSON.stringify(folded).length < JSON.stringify(native).length / 2,
    `folded ${JSON.stringify(folded).length} vs native ${JSON.stringify(native).length}`,
  );
  // Folding is presentation, not capability: the run has the same tools either way, which is what the catalog is
  // built from.
  assert.deepEqual(
    tools.specs({ mode: 'native' }).map((spec) => spec.name),
    native.map((spec) => spec.name),
  );
});

test('a registry without run_code is never folded to nothing', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => ({ isError: false, content: String(args.text) }),
  });
  registry.toolMode = 'ptc';
  assert.deepEqual(
    registry.specs().map((spec) => spec.name),
    ['echo'],
  );
  // The setting is a presentation choice, so it cannot be the thing that empties a run's capability set.
  const result = await registry.execute(
    { id: 'call', name: 'echo', arguments: { text: 'hi' } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.content, 'hi');
});

test('the mode comes from the setting, and a mistyped one is refused', () => {
  assert.equal(toolMode({}), 'native');
  assert.equal(toolMode({ YUANTU_TOOL_MODE: 'ptc' }), 'ptc');
  assert.equal(toolMode({ YUANTU_TOOL_MODE: 'native' }), 'native');
  assert.throws(() => toolMode({ YUANTU_TOOL_MODE: 'programmatic' }), /YUANTU_TOOL_MODE/);
});

test('the delegated run keeps the mode its parent was configured with', () => {
  const tools = createTools(process.cwd());
  tools.toolMode = 'ptc';
  const child = tools.forRun({ allow: ['run_code', 'read_file'] });
  assert.equal(child.toolMode, 'ptc');
  assert.deepEqual(
    child.specs().map((spec) => spec.name),
    [RUN_CODE],
  );
  // A read-only child's program is handed the child's own catalog, so the fold is a presentation of two tools
  // rather than of the parent's sixty.
  assert.match(child.specs()[0]!.description, /tools\.read_file/);
  assert.doesNotMatch(child.specs()[0]!.description, /tools\.write_file/);
});

test('without a catalog the tool says so instead of guessing', async (t) => {
  const { tools, context } = await workspaceFixture(t);
  const result = await tools.execute(
    { id: 'program', name: RUN_CODE, arguments: { code: 'return 1;' } },
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /does not expose a tool catalog/);
});

// ---- the seam as a run actually wires it ----

/**
 * The tests above build the catalog by hand, which proves the tool works but not that a *run* supplies one. This
 * one goes through the kernel: the model asks for a program, the program reads a file, and the next request sees
 * the file's text — which can only happen if `agent.ts` handed the tool the run's own registry.
 */
test('a run gives its program the run’s own tools', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-run-code-run-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\n');
  const session = store.create(root);
  const events: AgentEvent[] = [];
  let requests = 0;
  const provider: Provider = {
    async complete(request) {
      if (requests++ === 0)
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'program',
              name: RUN_CODE,
              arguments: {
                code: "const text = await tools.read_file({ path: 'notes.txt' });\nreturn text.includes('beta');",
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      // The second request is the run telling the model what happened: the program's answer, and the trace that
      // names the read the program made.
      const tool = request.messages.find((message) => message.role === 'tool');
      assert.match(tool?.content ?? '', /^true/);
      assert.match(tool?.content ?? '', /\[tools\] 1 call\(s\) in \d+ms: read_file/);
      return {
        text: 'read through a program',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const agent = new Agent({
    store,
    provider,
    approve: async () => true,
    tools: createTools(root),
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'read it with a program' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 2);
  // An inner call is not a second entry in the transcript: the model asked for one call and got one result. What
  // the program did is in that result's trace, and each inner call is still whatever it would have been — an
  // approved write, a refused gate, a journalled change.
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool.started')
      .map((event) => (event.data.call as { name?: string }).name),
    [RUN_CODE],
  );
});
