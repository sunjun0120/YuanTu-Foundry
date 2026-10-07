/**
 * The desktop's half of the structured tool result: does a *real* payload become the card it promises?
 *
 * The contract test (`tests/tool-output.test.ts`) proves a tool produces a value matching its declaration. This
 * one starts from that value and asks the next question: does the view the desktop dispatches on actually
 * understand it? The link between the two is a JSON Schema in one file and a hand-written validator in another,
 * which is exactly the kind of pair that drifts silently — the schema gains a field, the card keeps working, and
 * then one day a required field is renamed and the card quietly disappears, because a card that cannot be drawn
 * falls back to the text form and looks like a deliberate choice.
 *
 * So the happy paths below go through the **real tools**, not hand-written fixtures, and each one asserts the
 * field a person would read (the line range, the hits, the exit code). The rest of the file is the other half of
 * the contract: everything that is *not* the declared shape answers `null` — one answer for "print the text",
 * because a version skew must degrade to yesterday's output rather than to an empty box.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOOL_RENDERERS, type ToolResultOutput } from '../packages/protocol/tool-result.ts';
import type { Tool, ToolContext } from '../packages/protocol/index.ts';
import { commandTool } from '../packages/tools/command.ts';
import { fileTools } from '../packages/tools/files.ts';
import { toolCardModel } from '../apps/desktop/tool-card-model.ts';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-cards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function toolNamed(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} is not in the tool set`);
  return tool;
}
/** The model for a result, insisting there is one — the failure this file exists to catch. */
function modelOf(output: ToolResultOutput | undefined) {
  const model = toolCardModel(output);
  assert.ok(
    model,
    `no card for ${JSON.stringify(output?.render)}: ${JSON.stringify(output?.value)}`,
  );
  return model;
}

test('a file read becomes a card that says which lines it is', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'src.ts'), 'one\ntwo\nthree\nfour\n');
  const result = await toolNamed(fileTools(root), 'read_file').execute(
    { path: 'src.ts', start_line: 2, end_line: 3 },
    context(),
  );
  assert.deepEqual(modelOf(result.output), {
    kind: 'file-read',
    path: 'src.ts',
    language: 'typescript',
    startLine: 2,
    endLine: 3,
    totalLines: 4,
    // The card draws the raw lines: the numbering in the text form is the model's, not the card's.
    text: 'two\nthree',
    truncated: false,
  });
});

test('a search becomes a card that lists its hits', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'alpha\nbeta needle\ngamma\n');
  const result = await toolNamed(fileTools(root), 'search_files').execute(
    { query: 'needle' },
    context(),
  );
  assert.deepEqual(modelOf(result.output), {
    kind: 'search-results',
    query: 'needle',
    mode: 'literal',
    matches: [{ path: 'a.txt', line: 2, text: 'beta needle' }],
    limited: false,
  });
});

test('a command becomes a card that carries its own exit code and streams', async (t) => {
  const root = await workspace(t);
  // The scripts are files rather than `-e` one-liners on purpose: a command is shell text, and quoting a program
  // with spaces in its path through `cmd /c` is a different subject from what this test is about.
  await writeFile(
    path.join(root, 'fail.cjs'),
    "console.log('out');console.error('err');process.exit(3);",
  );
  await writeFile(path.join(root, 'pass.cjs'), 'console.log(1);');
  const tool = toolNamed([commandTool(root)], 'run_command');
  // A non-zero exit is the interesting case, and the reason the card exists: the exit code and the two streams
  // are the three things a person reads after a failing command, and the text form interleaves them.
  const failed = await tool.execute({ command: 'node fail.cjs' }, context());
  const failedCard = modelOf(failed.output);
  assert.equal(failedCard.kind, 'command-output');
  assert.ok(failedCard.kind === 'command-output');
  assert.equal(failedCard.exitCode, 3, 'the card shows the command’s own exit code');
  assert.equal(failedCard.signal, null);
  assert.equal(failedCard.timedOut, false);
  assert.match(failedCard.stdout, /out/);
  assert.match(failedCard.stderr, /err/);
  assert.equal(failedCard.truncated, false);
  assert.ok(failedCard.durationMs >= 0);
  // A success is a card too: the same three facts, with an exit code of zero.
  const passed = modelOf((await tool.execute({ command: 'node pass.cjs' }, context())).output);
  assert.ok(passed.kind === 'command-output');
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.stderr, '');
});

test('every renderer the protocol names has a card, and nothing else does', async (t) => {
  // The list is read from the protocol rather than repeated here: a fourth renderer added there must fail this
  // test until a card exists for it, which is the two-sided change the closed set was meant to force.
  const root = await workspace(t);
  await writeFile(path.join(root, 'a.txt'), 'needle\n');
  const tools = [...fileTools(root), commandTool(root)];
  const outputs: Record<string, ToolResultOutput | undefined> = {
    'file-read': (await toolNamed(tools, 'read_file').execute({ path: 'a.txt' }, context())).output,
    'search-results': (
      await toolNamed(tools, 'search_files').execute({ query: 'needle' }, context())
    ).output,
    'command-output': (
      await toolNamed(tools, 'run_command').execute({ command: 'node -e 0' }, context())
    ).output,
  };
  for (const renderer of TOOL_RENDERERS) {
    const model = toolCardModel(outputs[renderer]);
    assert.ok(model, `${renderer} has a card`);
    // The card's own name for the view is the protocol's: a card that answered with a different kind would be
    // drawn by the wrong branch without any type noticing.
    assert.equal(model.kind, renderer);
  }
  assert.equal(
    toolCardModel({
      render: 'a-view-that-does-not-exist',
      value: {},
    } as unknown as ToolResultOutput),
    null,
    'a name outside the set is nobody’s card',
  );
});

test('anything that is not the declared shape falls back to the text form', () => {
  // Each of these is a real skew rather than a hypothetical: a result with no payload at all (a tool with no
  // contract, a refused call), a payload from an older build, and a payload whose field changed type. All of
  // them must answer the same way, because the caller has exactly one fallback.
  const command = {
    command: 'echo hi',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 5,
    stdout: 'hi',
    stderr: '',
    truncated: false,
  };
  assert.equal(toolCardModel(undefined), null);
  assert.equal(toolCardModel({ render: 'command-output', value: null }), null);
  assert.equal(toolCardModel({ render: 'command-output', value: 'text' }), null);
  assert.equal(toolCardModel({ render: 'command-output', value: [] }), null);
  const { stdout, ...missingField } = command;
  assert.equal(stdout, 'hi');
  assert.equal(toolCardModel({ render: 'command-output', value: missingField }), null);
  assert.equal(
    toolCardModel({ render: 'command-output', value: { ...command, exitCode: '0' } }),
    null,
    'a string where the schema says integer is a skew, not a value to render',
  );
  // The mirror of that: a real null exit code is a killed child, not a skew, and must still draw — on Windows a
  // killed child often reports neither a code nor a signal, and the two streams are still worth reading.
  for (const value of [
    { ...command, exitCode: null, signal: 'SIGKILL' },
    { ...command, exitCode: null },
  ]) {
    const model = toolCardModel({ render: 'command-output', value });
    assert.ok(model?.kind === 'command-output');
    assert.equal(model.exitCode, null);
  }
  assert.equal(
    toolCardModel({
      render: 'file-read',
      value: {
        path: 'a.txt',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        text: 'x',
        truncated: false,
      },
    })?.kind,
    'file-read',
    'a read with no language is a card: the field is optional, and absence is a fact',
  );
  assert.equal(
    toolCardModel({
      render: 'search-results',
      value: {
        query: 'q',
        mode: 'literal',
        matches: [{ path: 'a', line: 0, text: 'x' }],
        limited: false,
      },
    }),
    null,
    'a match on line zero is not a line',
  );
  // A field from a newer build is ignored rather than refused: forward compatibility is the whole reason the
  // card reads the fields it needs instead of comparing the object to a fixed list.
  assert.equal(
    toolCardModel({ render: 'command-output', value: { ...command, futureField: 1 } })?.kind,
    'command-output',
  );
});
