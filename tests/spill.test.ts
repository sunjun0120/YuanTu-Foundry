/**
 * Tool output too large to return.
 *
 * A result used to be cut at 24,000 characters and the rest was gone: the model saw a marker and could not
 * ask for the part it needed, and the user could not see it either. Now the whole output is written under
 * `.yuantu/spill/<session>/` and the result names the file, its size and its line count, which `read_file`
 * can page through. These tests are about the two halves that make that worth doing: *nothing is lost*, and
 * *the model can actually get it back*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, MAX_TOOL_OUTPUT, bounded } from '../packages/tools/registry.ts';
import { createTools } from '../packages/catalog/index.ts';
import { SPILL_DIRECTORY, spillOutput, spillResult } from '../packages/tools/spill.ts';
import { Agent } from '../packages/core/agent.ts';
import type { Message, ToolContext } from '../packages/protocol/index.ts';
import { tempRoot, storeFixture } from './temp-fixture.ts';
import { reply } from './provider-fixture.ts';

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  ...overrides,
});

test('output over the limit is written out whole and the result says where', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-');
  const tools = new ToolRegistry();
  const long = Array.from({ length: 4000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join(
    '\n',
  );
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: long };
    },
  });
  const result = await tools.execute(
    { id: 'n1', name: 'noisy', arguments: {} },
    context({ spill: (input) => spillOutput({ workspace: root, sessionId: 's1', ...input }) }),
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.length < long.length, 'the result itself stays bounded');
  assert.ok(result.content.startsWith(long.slice(0, 100)), 'it keeps the beginning of the output');
  const notice = result.content.slice(MAX_TOOL_OUTPUT);
  assert.match(notice, /output truncated at 24000 characters/);
  assert.match(notice, /read_file/);
  const relative = /the full \d+ bytes \/ \d+ lines are in (.+?) —/.exec(notice)?.[1];
  assert.ok(relative, `the notice names the file: ${notice}`);
  assert.ok(relative.startsWith('.yuantu/spill/s1/'), relative);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), long, 'nothing was lost');
  assert.match(notice, new RegExp(`${Buffer.byteLength(long, 'utf8')} bytes`));
  assert.match(notice, /4000 lines/);
});

test('a result a tool already truncated is not spilled as though it were complete', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-cut-');
  const tools = new ToolRegistry();
  /**
   * The tool cuts its own output. This is what made the old length test wrong: `bounded` appends its marker
   * outside the budget, so the result came back at `MAX_TOOL_OUTPUT + marker.length` and the result stage read
   * that as "more output than I can carry" — it spilled the *already truncated* text and the notice promised a
   * complete file that was itself cut, which is the one thing the notice exists to rule out.
   */
  tools.register({
    name: 'self-cut',
    description: 'Truncates its own output before returning it',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: bounded('q'.repeat(MAX_TOOL_OUTPUT * 2)) };
    },
  });
  let spills = 0;
  const result = await tools.execute(
    { id: 'c1', name: 'self-cut', arguments: {} },
    context({
      spill: (input) => {
        spills++;
        return spillOutput({ workspace: root, sessionId: 's1', ...input });
      },
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(spills, 0, 'nothing was spilled, because nothing complete was withheld');
  assert.doesNotMatch(result.content, /the full .* are in/);
  assert.match(result.content, /\[output truncated\]$/);
});

test('a tool that says it cut its own output is spilled, and the notice says what the copy is', async (t) => {
  /**
   * The other half of the same distinction, and the one `run_command` is in.
   *
   * That tool bounds its output at two megabytes — deliberately above the inline budget, so the result stage has
   * something worth writing out — which means the text it hands over is itself short of what the command printed.
   * Skipping the spill would throw away the only copy of a build log; spilling it under "the full N bytes" was the
   * lie the item is about. The prose in the text could not say which case it was (nothing reads a sentence), so the
   * tool declares it and the notice repeats it.
   */
  const root = await tempRoot(t, 'yuantu-spill-declared-');
  const tools = new ToolRegistry();
  const captured = 'c'.repeat(MAX_TOOL_OUTPUT * 2);
  tools.register({
    name: 'bounded-by-itself',
    description: 'Bounds its own output far above the inline budget',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: captured, truncated: true };
    },
  });
  let spills = 0;
  const result = await tools.execute(
    { id: 'd1', name: 'bounded-by-itself', arguments: {} },
    context({
      spill: (input) => {
        spills++;
        return spillOutput({ workspace: root, sessionId: 's1', ...input });
      },
    }),
  );
  assert.equal(spills, 1, 'the captured text is the only copy, so it is written out');
  assert.equal(result.truncated, true, 'and the result still says the tool cut it');
  const notice = result.content.slice(MAX_TOOL_OUTPUT);
  assert.match(notice, /the captured \d+ bytes/);
  assert.match(notice, /the tool had already cut its own output/);
  assert.doesNotMatch(
    notice,
    /the full \d+ bytes/,
    'the notice no longer promises a tail the file does not have',
  );
  const relative = /are in (.+?),/.exec(notice)?.[1];
  assert.ok(relative, `the notice names the file: ${notice}`);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), captured);
});

test('a spill is written the way the credential store is: private to the user', async (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX permission bits are not a Windows concept');
  const root = await tempRoot(t, 'yuantu-spill-mode-');
  // A spill is a copy of output a tool read — file contents, a command's stdout — so it is as private as the
  // credentials in `packages/mcp/oauth.ts`, which is where this 0700/0600 pair is already used.
  spillOutput({ workspace: root, sessionId: 's1', tool: 'run_command', content: 'secret output' });
  spillResult({ workspace: root, sessionId: 's1', key: 'call-1', content: 'shortened output' });
  const directory = path.join(root, SPILL_DIRECTORY, 's1');
  assert.equal(
    (await stat(directory)).mode & 0o777,
    0o700,
    'the spill directory is group/world readable',
  );
  for (const name of await readdir(directory))
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600, name);
});

test('the model can read a spilled output back with read_file', async (t) => {
  const { root, session } = await storeFixture(t, 'yuantu-spill-read-');
  const tools = createTools(root);
  const long = Array.from({ length: 3000 }, (_, index) => `needle-${index}`).join('\n');
  // What a long tool output leaves behind once the result stage has spilled it.
  const spilled = spillOutput({
    workspace: root,
    sessionId: session.id,
    tool: 'run_command',
    content: long,
  })!;
  const read = await tools.execute(
    {
      id: 'r2',
      name: 'read_file',
      arguments: { path: spilled.path, start_line: 2999, end_line: 3000 },
    },
    context(),
  );
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /2999: needle-2998/);
  // Writing to the spill directory is still refused: the exception is for reads only.
  const write = await tools.execute(
    { id: 'w1', name: 'write_file', arguments: { path: spilled.path, content: 'tampered' } },
    context(),
  );
  assert.equal(write.isError, true);
  assert.equal(await readFile(path.join(root, spilled.path), 'utf8'), long);
  // And nothing else under `.yuantu` opened up: the session database stays unreachable.
  const database = await tools.execute(
    { id: 'r3', name: 'read_file', arguments: { path: '.yuantu/sessions.sqlite' } },
    context(),
  );
  assert.equal(database.isError, true);
});

test('spill reads accept equivalent workspace paths', async (t) => {
  /**
   * The spill exception is about *which file* is being read, not how the argument was spelled.
   *
   * It was decided by cutting the raw argument on separators, so `./.yuantu/spill/...` and
   * `x/../.yuantu/spill/...` — the same file by every other rule in the workspace — were not recognized as
   * spills. They fell through to the scoped-instruction lookup, which refuses everything under `.yuantu`
   * ("Instruction target is an excluded directory"), so a spilled output was readable at exactly one
   * spelling. The identity now comes from the resolved path; the exception still covers only `.yuantu/spill`,
   * still only for reads, and never the credential names below it.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-alias-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-alias-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const tools = createTools(root);
  const body = 'spilled output body';
  const spilled = spillOutput({
    workspace: root,
    sessionId: 's1',
    tool: 'run_command',
    content: body,
  })!;
  assert.ok(spilled.path.startsWith('.yuantu/spill/'), spilled.path);
  const spellings = [spilled.path, `./${spilled.path}`, `x/../${spilled.path}`];
  // Windows accepts either separator; on POSIX a backslash is an ordinary character in a file name, so this
  // one spelling only exists there.
  if (process.platform === 'win32') spellings.push(spilled.path.split('/').join('\\'));
  for (const spelling of spellings) {
    const read = await tools.execute(
      { id: 'r', name: 'read_file', arguments: { path: spelling } },
      context(),
    );
    assert.equal(read.isError, false, `${spelling}: ${read.content}`);
    assert.match(read.content, new RegExp(body));
    // One file, one identity in the payload: a card and a later change tool must agree about which file it is.
    assert.equal((read.output!.value as { path: string }).path, spilled.path, spelling);
  }
  /**
   * The exception is keyed on the canonical spelling, not on a case-folded one.
   *
   * `Workspace.resolve` compares the parts of the path as written against the excluded directory names and
   * case-folds only for the *credential* test, so `.YUANTU/spill/...` is refused there (or does not exist on a
   * case-sensitive filesystem) — which is what keeps this exemption narrow. A blanket `toLowerCase` here would
   * have opened the internal directory on every case-insensitive platform.
   */
  const cased = await tools.execute(
    {
      id: 'C',
      name: 'read_file',
      arguments: { path: spilled.path.replace('.yuantu', '.YUANTU') },
    },
    context(),
  );
  assert.equal(cased.isError, true, cased.content);
  // The exception is the spill directory's identity, not a licence for everything below it: a credential name
  // nested under the spill directory is still refused at every spelling.
  await mkdir(path.join(root, '.yuantu', 'spill', 'credentials.json'));
  const nestedCredential = path.join(root, '.yuantu', 'spill', 'credentials.json', 'hidden.txt');
  await writeFile(nestedCredential, 'CREDENTIAL_MARKER');
  for (const spelling of [
    '.yuantu/spill/credentials.json/hidden.txt',
    './.yuantu/spill/credentials.json/hidden.txt',
  ]) {
    const denied = await tools.execute(
      { id: 'c', name: 'read_file', arguments: { path: spelling } },
      context(),
    );
    assert.equal(denied.isError, true, spelling);
    assert.ok(!denied.content.includes('CREDENTIAL_MARKER'), spelling);
  }
  // A directory link under the spill directory is still a link, and is still followed nowhere.
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
  await symlink(
    outside,
    path.join(root, '.yuantu', 'spill', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linked = await tools.execute(
    { id: 'l', name: 'read_file', arguments: { path: './.yuantu/spill/linked/secret.txt' } },
    context(),
  );
  assert.equal(linked.isError, true);
  assert.ok(!linked.content.includes('OUTSIDE_SECRET'));
  // Leaving the workspace is still refused, however the argument is spelled.
  for (const spelling of ['../outside.txt', './.yuantu/spill/../../../outside.txt']) {
    const escaped = await tools.execute(
      { id: 'o', name: 'read_file', arguments: { path: spelling } },
      context(),
    );
    assert.equal(escaped.isError, true, spelling);
  }
  // The read exception never opened the write path, and the file it names is untouched.
  const written = await tools.execute(
    { id: 'w', name: 'write_file', arguments: { path: `./${spilled.path}`, content: 'tampered' } },
    context(),
  );
  assert.equal(written.isError, true);
  assert.equal(await readFile(path.join(root, spilled.path), 'utf8'), body);
});

test('a spill that cannot be written falls back to plain truncation', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: 'y'.repeat(MAX_TOOL_OUTPUT + 5000) };
    },
  });
  const result = await tools.execute(
    { id: 'n1', name: 'noisy', arguments: {} },
    context({
      spill: () => {
        throw new Error('disk is full');
      },
    }),
  );
  // The tool already ran: its effect is recorded, and a result that could not be shortened is a smaller
  // problem than reporting the effect as a failure. The truncation marker is the honest fallback.
  assert.equal(result.isError, false);
  assert.equal(result.content.length, MAX_TOOL_OUTPUT + '\n[output truncated]'.length);
  assert.match(result.content, /\[output truncated\]$/);
});

test('a run spills through its own session, and the transcript points at the file', async (t) => {
  const { root, store, session } = await storeFixture(t, 'yuantu-spill-run-');
  const long = 'z'.repeat(MAX_TOOL_OUTPUT * 2);
  const tools = createTools(root);
  // A tool whose output is longer than a result can carry: the run's own registry is what the pipeline
  // spills through, so this is the path a real tool takes.
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: long };
    },
  });
  let turn = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'noisy-1', name: 'noisy', arguments: {} }],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : reply('done');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Produce a lot' });
  assert.equal(result.status, 'completed', result.error);
  const tool = store.messages(session.id).find((message) => message.role === 'tool') as Message;
  const relative = /are in (.+?) —/.exec(String(tool.content))?.[1]!;
  assert.ok(
    relative.startsWith(`${SPILL_DIRECTORY.split(path.sep).join('/')}/${session.id}/`),
    relative,
  );
  assert.equal(await readFile(path.join(root, relative), 'utf8'), long);
});

test('spill caps actual utf8 bytes without broken characters', async (t) => {
  /**
   * The cap is stated in bytes and the cut used to be made with `content.slice(0, MAX_SPILL_BYTES)`, which counts
   * UTF-16 code units: 8,000,000 Chinese characters became a 24,000,000-byte file, and a cut on an odd code unit
   * left half a surrogate pair behind. Both halves are asserted here — what lands on disk is within the byte cap,
   * and what it holds still decodes as whole characters of the content it came from.
   */
  const root = await tempRoot(t, 'yuantu-spill-bytes-');
  const limit = 8_000_000;
  const cases = [
    { name: 'ascii', content: 'a'.repeat(limit + 1), cut: true },
    { name: 'cjk', content: '中'.repeat(limit + 1), cut: true },
    // Four bytes per character, so this one crosses the cap by a single character.
    { name: 'emoji', content: '\u{1F600}'.repeat(limit / 4 + 1), cut: true },
    // Exactly the cap in whole characters: nothing is cut, so nothing may be lost to a boundary rule.
    { name: 'exact', content: '\u{1F600}'.repeat(limit / 4), cut: false },
  ];
  for (const item of cases) {
    const spilled = spillOutput({
      workspace: root,
      sessionId: 's1',
      tool: item.name,
      content: item.content,
    })!;
    const file = path.join(root, spilled.path);
    const size = (await stat(file)).size;
    assert.ok(size <= limit, `${item.name}: ${size} bytes on disk is over the ${limit}-byte cap`);
    assert.equal(spilled.bytes, size, `${item.name}: the reported size is the file's`);
    const text = await readFile(file, 'utf8');
    // A cut inside a character decodes back as U+FFFD, which is the corruption this rules out.
    assert.ok(!text.includes('\uFFFD'), `${item.name}: the cut broke a character`);
    assert.ok(
      item.content.startsWith(text),
      `${item.name}: what was kept is a prefix of the content`,
    );
    if (item.cut) assert.ok(text.length < item.content.length, `${item.name}: over the cap is cut`);
    else assert.equal(text, item.content, `${item.name}: exactly the cap is left whole`);
  }
});

test('a tool name can neither escape the spill directory nor grow without bound', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-name-');
  // The name says which tool produced the spill, but it is a tool's own name and nothing in it may climb out
  // of the session's directory — a spill is a copy of whatever the tool read.
  const escaping = spillOutput({
    workspace: root,
    sessionId: 'name-session',
    tool: '../../outside',
    content: 'x',
  })!;
  assert.ok(escaping);
  const directory = path.resolve(root, SPILL_DIRECTORY, 'name-session');
  assert.equal(escaping.path.includes('..'), false, `escaped the directory: ${escaping.path}`);
  assert.ok(
    path.resolve(root, escaping.path).startsWith(`${directory}${path.sep}`),
    `the file is not under the session directory: ${escaping.path}`,
  );
  // And a name is not allowed to be arbitrarily long either.
  const long = spillOutput({
    workspace: root,
    sessionId: 'name-session',
    tool: 'x'.repeat(400),
    content: 'y',
  })!;
  assert.ok(long);
  const name = path.basename(long.path);
  assert.ok(
    name.startsWith('x'.repeat(40)),
    `the name is not the sanitised, capped prefix: ${name}`,
  );
  assert.ok(name.length <= 64, `the name grew past the cap: ${name.length} characters`);
});

test('a session keeps only the newest spills', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-trim-');
  const directory = path.join(root, SPILL_DIRECTORY, 'trim-session');
  await mkdir(directory, { recursive: true });
  // The older spills get explicit times, so "newest" does not depend on filesystem timestamp granularity —
  // fifty files written in one loop would otherwise share a timestamp and the order would be arbitrary.
  for (let index = 0; index < 50; index++) {
    const file = path.join(directory, `old-${String(index).padStart(3, '0')}.txt`);
    await writeFile(file, 'old');
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    await utimes(file, at, at);
  }
  const spilled = spillOutput({
    workspace: root,
    sessionId: 'trim-session',
    tool: 'search',
    content: 'newest',
  })!;
  assert.ok(spilled);
  const remaining = (await readdir(directory)).filter((name) => name.endsWith('.txt')).sort();
  // A directory left to grow is a tool that can fill a disk one output at a time.
  assert.equal(remaining.length, 50, `kept ${remaining.length} files`);
  assert.equal(remaining.includes('old-000.txt'), false, 'the oldest spill was kept');
  assert.ok(remaining.includes(path.basename(spilled.path)), 'the newest spill was trimmed away');
});

test('an unchanged projection is not written to disk again', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-projection-');
  const input = {
    workspace: root,
    sessionId: 'projection-session',
    key: 'call-1',
    content: 'the same text as last round',
  };
  const first = spillResult(input)!;
  assert.ok(first);
  const file = path.resolve(root, first.path);
  const before = await stat(file);
  // Long enough that a rewrite would land on a different modification time.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = spillResult(input)!;
  assert.deepEqual(second, first);
  // Shortening is a projection recomputed every round: rewriting the file would mean touching the disk on
  // every round and changing nothing the model reads.
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs, 'the file was rewritten');
});

test('two sessions with the same tool call do not share a spilled file', async (t) => {
  const root = await tempRoot(t, 'yuantu-spill-identity-');
  // The file name is the message's identity, and a tool call id is only unique within its own session.
  const one = spillResult({
    workspace: root,
    sessionId: 'session-one',
    key: 'call-1',
    content: 'the first session said this',
  })!;
  const two = spillResult({
    workspace: root,
    sessionId: 'session-two',
    key: 'call-1',
    content: 'the second session said that',
  })!;
  assert.ok(one && two);
  assert.notEqual(one.path, two.path, 'both sessions point at the same file');
  assert.equal(await readFile(path.resolve(root, one.path), 'utf8'), 'the first session said this');
  assert.equal(
    await readFile(path.resolve(root, two.path), 'utf8'),
    'the second session said that',
  );
});

for (const count of [1000, 3000]) {
  test(`a git diff is spilled without losing captured bytes (${count} lines)`, async (t) => {
    const root = await tempRoot(t, 'yuantu-spill-git-');
    const git = (args: string[]) =>
      promisify(execFile)('git', args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      });
    await git(['init']);
    const file = path.join(root, 'big.txt');
    await writeFile(file, 'before\n');
    await git(['add', 'big.txt']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--no-verify',
      '-m',
      'fixture',
    ]);
    /**
     * Cover both a complete capture and one exceeding the command's capture limit. In either case the
     * registry must spill every captured byte, and describe a partial capture accurately.
     */
    const lines = Array.from({ length: count }, (_, index) => `+line ${index} ${'y'.repeat(20)}`);
    await writeFile(file, `${lines.join('\n')}\n`);
    const tools = createTools(root);
    t.after(() => tools.close());
    const result = await tools.execute(
      { id: 'g1', name: 'git_diff', arguments: {} },
      context({ spill: (input) => spillOutput({ workspace: root, sessionId: 's1', ...input }) }),
    );
    assert.equal(result.isError, false, result.content);
    // The returned text is the prefix plus the notice naming the spilled file, so it stays near the budget
    // rather than within it: the notice is appended outside `MAX_TOOL_OUTPUT` on purpose.
    assert.ok(result.content.length < MAX_TOOL_OUTPUT + 512, String(result.content.length));
    const relative = /the (?:full|captured) \d+ bytes \/ \d+ lines are in (.+?)(?:,| —)/.exec(
      result.content,
    )?.[1];
    assert.ok(relative, `the notice names the spill file: ${result.content.slice(-300)}`);
    const spilled = await readFile(path.join(root, relative), 'utf8');
    assert.ok(spilled.length > MAX_TOOL_OUTPUT, 'the copy must hold more than the returned prefix');
    const expected = await git(['diff', '--no-ext-diff', '--no-textconv', '--']);
    assert.equal(
      spilled,
      expected.stdout.slice(0, MAX_TOOL_OUTPUT * 2),
      'all bytes captured by Git survive in the spill',
    );
    if (count === 3000) {
      assert.equal(result.truncated, true);
      assert.match(result.content, /the captured 48000 bytes/);
      assert.doesNotMatch(result.content, /the full 48000 bytes/);
    } else assert.ok(spilled.includes(lines.at(-1)!), 'the complete tail survived');
    assert.ok(!spilled.includes('[output truncated]'), 'the capture itself was not cut');
  });
}
