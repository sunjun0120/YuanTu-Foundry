import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Approval,
  FileChange,
  FileSnapshot,
  ToolContext,
} from '../packages/protocol/index.ts';
import { createTools } from '../packages/tools/index.ts';
import {
  MessageDecoder,
  applyTextEdits,
  encodeMessage,
  offsetAt,
  toDisplayRange,
  toProtocolPosition,
} from '../packages/lsp/protocol.ts';
import { findExecutable, languageForFile, resolveServers } from '../packages/lsp/servers.ts';
import { LspClient } from '../packages/lsp/client.ts';

// ---- merged from lsp.test.ts ----

const FIXTURE = fileURLToPath(new URL('./lsp-fixture.ts', import.meta.url));
/** Waits briefly for a file the fixture writes, so an assertion is not a timing guess. */
async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});
/** Waits for a process to be gone, so "it was killed" is a question with an answer rather than a timing guess. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

function recording(allow = true): { context: ToolContext; approvals: Approval[] } {
  const approvals: Approval[] = [];
  return {
    approvals,
    context: {
      signal: new AbortController().signal,
      approve: async (approval: Approval) => {
        approvals.push(approval);
        return allow;
      },
    },
  };
}

/** A workspace whose `.yuantu/lsp.json` points the "fake" language at the fixture server. */
async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lsp-'));
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        fake: {
          command: process.execPath,
          args: [FIXTURE],
          extensions: ['.fake'],
        },
      },
    }),
  );
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, tools };
}

test('LSP framing decoder reassembles split messages and splits coalesced ones', () => {
  const decoder = new MessageDecoder();
  const first = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' });
  const second = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' });
  assert.deepEqual(decoder.push(first.subarray(0, 10)), []);
  assert.ok(decoder.pending > 0);
  assert.deepEqual(decoder.push(first.subarray(10)), [{ jsonrpc: '2.0', id: 1, method: 'a' }]);
  assert.deepEqual(decoder.push(Buffer.concat([second, first])), [
    { jsonrpc: '2.0', id: 2, method: 'b' },
    { jsonrpc: '2.0', id: 1, method: 'a' },
  ]);
  // A header promising more bytes than have arrived must wait, not fail.
  assert.deepEqual(decoder.push(Buffer.from('Content-Length: 50\r\n\r\n{"a"')), []);
});

test('LSP framing decoder rejects malformed or oversized headers', () => {
  assert.throws(() => new MessageDecoder().push(Buffer.from('X: 1\r\n\r\n{}')), /Content-Length/);
  assert.throws(() => new MessageDecoder().push(Buffer.alloc(9_000, 0x41)), /8KB/);
  const bad = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' });
  const corrupt = Buffer.concat([
    Buffer.from('Content-Length: 3\r\n\r\n', 'ascii'),
    Buffer.from('nope', 'ascii'),
  ]);
  assert.throws(() => new MessageDecoder().push(corrupt), /not valid JSON/);
  assert.ok(bad.length > 0);
});

test('tool positions are 1-based and converted to 0-based protocol positions', () => {
  assert.deepEqual(toProtocolPosition(3, 5), { line: 2, character: 4 });
  assert.deepEqual(
    toDisplayRange({ start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }),
    { line: 3, character: 5, endLine: 3, endCharacter: 10 },
  );
  assert.throws(() => toProtocolPosition(0, 1), /1-based/);
  assert.throws(() => toProtocolPosition(1, 0), /1-based/);
  assert.throws(() => toProtocolPosition(1.5, 1), /1-based/);
});

test('offsets count UTF-16 code units, which is what LSP characters mean', () => {
  const text = 'const a = "😀";\nconst b = 1;\n';
  assert.equal(offsetAt(text, { line: 0, character: 0 }), 0);
  assert.equal(offsetAt(text, { line: 1, character: 0 }), 16);
  assert.equal(
    text.slice(
      offsetAt(text, { line: 1, character: 6 }),
      offsetAt(text, { line: 1, character: 7 }),
    ),
    'b',
  );
  assert.equal(offsetAt(text, { line: 99, character: 0 }), text.length);
});

test('text edits apply from the end so earlier ranges stay valid', () => {
  assert.equal(
    applyTextEdits('one two three', [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: '1',
      },
      {
        range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } },
        newText: '3',
      },
    ]),
    '1 two 3',
  );
  assert.throws(
    () =>
      applyTextEdits('abc', [
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } },
          newText: 'x',
        },
      ]),
    /inverted/,
  );
});

test('the server catalog merges .yuantu/lsp.json and can disable built-ins', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspcfg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        python: { disabled: true },
        fake: { command: 'fake-ls', args: ['--stdio'], extensions: ['.fake'] },
        broken: { extensions: ['.broken'] },
      },
    }),
  );
  const { servers, problems } = await resolveServers(root);
  const languages = servers.map((server) => server.language);
  assert.ok(!languages.includes('python'), 'a disabled built-in must disappear');
  assert.ok(languages.includes('typescript'), 'other built-ins must survive');
  assert.equal(servers.find((server) => server.language === 'fake')?.command, 'fake-ls');
  assert.equal(servers.find((server) => server.language === 'fake')?.args[0], '--stdio');
  assert.ok(
    problems.some((problem) => problem.includes('broken')),
    'an entry without a command is reported rather than silently accepted',
  );
  assert.equal(languageForFile(path.join(root, 'a.fake'), servers)?.language, 'fake');
  assert.equal(languageForFile(path.join(root, 'a.ts'), servers)?.language, 'typescript');
  assert.equal(languageForFile(path.join(root, 'a.d.ts'), servers)?.language, 'typescript');
  assert.equal(languageForFile(path.join(root, 'a.txt'), servers), undefined);
});

test('a malformed .yuantu/lsp.json is reported and the built-in catalog still works', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspbad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(path.join(root, '.yuantu', 'lsp.json'), '{not json');
  const { servers, problems } = await resolveServers(root);
  assert.ok(problems.some((problem) => problem.includes('not valid JSON')));
  assert.ok(servers.some((server) => server.language === 'typescript'));
});

test('findExecutable resolves a real command and reports a missing one', async () => {
  assert.ok(await findExecutable('node'));
  assert.equal(await findExecutable('yuantu-missing-command-xyz'), undefined);
});

test('a language server starts behind an approval and answers every tool', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'const TARGET = 1;\nBADTOKEN here\n');
  const { context, approvals } = recording();

  const servers = await tools.execute(call('lsp_servers', {}), context);
  assert.equal(servers.isError, false, servers.content);
  assert.match(servers.content, /"language": "fake"/);
  assert.match(servers.content, /"available": true/);
  assert.match(servers.content, /"running": false/);

  const started = await tools.execute(call('lsp_start', { language: 'fake' }), context);
  assert.equal(started.isError, false, started.content);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, 'command');
  assert.match(approvals[0]!.description, /Start the fake language server/);
  assert.match(approvals[0]!.description, /lsp-fixture\.ts/);

  const diagnostics = await tools.execute(
    call('lsp_diagnostics', { paths: ['main.fake'] }),
    context,
  );
  assert.equal(diagnostics.isError, false, diagnostics.content);
  assert.match(diagnostics.content, /main\.fake:/);
  assert.match(
    diagnostics.content,
    /2:1 error \[fake\/bad-token\] \(fake-ls\) BADTOKEN is not allowed/,
  );

  // A real edit must produce a fresh publish, not the stale cached list.
  await writeFile(path.join(root, 'main.fake'), 'const TARGET = 1;\nconst ok = 2;\n');
  const clean = await tools.execute(call('lsp_diagnostics', { paths: ['main.fake'] }), context);
  assert.equal(clean.content, 'No diagnostics');

  // Without paths the tool reports everything the running server published.
  const aggregate = await tools.execute(call('lsp_diagnostics', {}), context);
  assert.equal(aggregate.content, 'No cached diagnostics');

  const definition = await tools.execute(
    call('lsp_definition', { path: 'main.fake', line: 3, character: 5 }),
    context,
  );
  assert.match(definition.content, /"path": "main\.fake"/);
  assert.match(definition.content, /"line": 3/);
  assert.match(definition.content, /"character": 5/);

  const references = await tools.execute(
    call('lsp_references', { path: 'main.fake', line: 1, character: 1 }),
    context,
  );
  assert.match(references.content, /other\.fake/);

  const hover = await tools.execute(
    call('lsp_hover', { path: 'main.fake', line: 1, character: 1 }),
    context,
  );
  assert.match(hover.content, /const TARGET: number/);

  const symbols = await tools.execute(call('lsp_symbols', { path: 'main.fake' }), context);
  assert.match(symbols.content, /1:10 function outer/);
  assert.match(symbols.content, /2:7 variable outer\.inner/);

  const stopped = await tools.execute(call('lsp_stop', { language: 'fake' }), context);
  assert.equal(stopped.content, '{"stopped":true}');
  const afterStop = await tools.execute(call('lsp_diagnostics', { paths: ['main.fake'] }), context);
  assert.match(afterStop.content, /no running language server handles this file/);
});

test('diagnostics cannot claim success when no server checked the requested files', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'BADTOKEN\n');
  for (const arguments_ of [{}, { paths: ['main.fake'] }]) {
    const result = await tools.execute(call('lsp_diagnostics', arguments_), ctx());
    assert.equal(result.isError, true, result.content);
    assert.doesNotMatch(result.content, /^No diagnostics/);
    assert.match(result.content, /lsp_start|no running language server/);
  }
  await writeFile(path.join(root, 'unknown.txt'), 'fixture\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const partial = await tools.execute(
    call('lsp_diagnostics', { paths: ['main.fake', 'unknown.txt'] }),
    ctx(),
  );
  assert.equal(partial.isError, true, partial.content);
  assert.match(partial.content, /BADTOKEN/);
  assert.match(partial.content, /unknown.txt: no running language server/);
});

test('navigation tools explain that lsp_start comes first', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'const TARGET = 1;\n');
  const result = await tools.execute(
    call('lsp_definition', { path: 'main.fake', line: 1, character: 1 }),
    ctx(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /call lsp_start/);
});

test('a crashing language server is reported instead of hanging', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'crash.fake'), 'CRASH\n');
  const started = await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  assert.equal(started.isError, false, started.content);
  const diagnostics = await tools.execute(
    call('lsp_diagnostics', { paths: ['crash.fake'] }),
    ctx(),
  );
  assert.equal(diagnostics.isError, true);
  assert.match(diagnostics.content, /not running|exited/i);
});

test('the diagnostics wait is bounded when a server never publishes', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'slow.fake'), 'NODIAGNOSTICS\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const started = Date.now();
  const result = await tools.execute(
    call('lsp_diagnostics', { paths: ['slow.fake'], timeout_ms: 400 }),
    ctx(),
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /has not published yet/);
  assert.ok(Date.now() - started < 5_000, 'the wait must not outlive the requested timeout');
});

test('language servers refuse unsupported container backends', async (t) => {
  const previous = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  try {
    const { root, tools } = await workspace(t);
    await writeFile(path.join(root, 'main.fake'), 'const TARGET = 1;\n');
    const started = await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
    assert.equal(started.isError, true);
    assert.match(started.content, /backend unsupported/);
    const servers = await tools.execute(call('lsp_servers', {}), ctx());
    assert.match(servers.content, /"available": false/);
  } finally {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
  }
});

test('an unknown language reports the configuration file it needs', async (t) => {
  const { tools } = await workspace(t);
  const result = await tools.execute(call('lsp_start', { language: 'cobol' }), ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /\.yuantu\/lsp\.json/);
});

test('a server that dies at startup reports its own stderr and how to repair it', async (t) => {
  // A command can be found yet still be unusable: a rustup proxy whose component
  // is missing is the real-world case. "exited with code 1" alone is useless.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspbroken-'));
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        broken: {
          command: process.execPath,
          args: [FIXTURE, '--crash-on-start'],
          extensions: ['.broken'],
          install: 'npm install -D fake-language-server',
        },
      },
    }),
  );
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await tools.execute(call('lsp_start', { language: 'broken' }), ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /missing component "fake-core"/, 'the server stderr must survive');
  assert.match(
    result.content,
    /Install or repair it with: npm install -D fake-language-server/,
    'the catalog repair hint must be appended',
  );
  // A failed start must not leave a half-registered client behind.
  const retry = await tools.execute(call('lsp_start', { language: 'broken' }), ctx());
  assert.equal(retry.isError, true);
  assert.match(retry.content, /missing component "fake-core"/);
});

test('a server that rejects initialize is shut down gracefully instead of being leaked', async (t) => {
  // Two defects met here: a failed initialize left a live language server holding the workspace,
  // and stop() cleared `child` before the shutdown request, so the graceful handshake always threw
  // and every stop fell through to killTree. The fixture records which lifecycle messages actually
  // arrived, so both are observable.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspreject-'));
  const marker = path.join(root, 'lifecycle');
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        rejecting: {
          command: process.execPath,
          args: [FIXTURE, '--reject-on-start'],
          extensions: ['.reject'],
          env: { FAKE_LSP_LIFECYCLE_MARKER: marker },
        },
      },
    }),
  );
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await tools.execute(call('lsp_start', { language: 'rejecting' }), ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /cannot initialize this workspace/);
  // `shutdown` proves the handshake ran with the child still reachable; `exit` proves the server
  // was allowed to terminate itself rather than being killed outright.
  await waitForFile(marker);
  await waitForFile(`${marker}.exited`);
});

test('a request nobody is waiting for any more is cancelled at the server', async (t) => {
  /**
   * An abort used to reject the promise and forget the request, which is only half of stopping: the server keeps
   * computing the answer. These are the expensive requests — workspace-wide `references`, a `rename` a server
   * resolves before it can answer — so a Stop or a timeout left work running on a process the cancellation was
   * supposed to quiet. `$/cancelRequest` is the protocol's own way to say so, and the fixture records what it is
   * told rather than what the client believes it sent.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspcancel-'));
  const cancelMarker = path.join(root, 'cancels');
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        silent: {
          command: process.execPath,
          // The server takes every request and answers none, so the only way this call ends is cancellation.
          args: [FIXTURE, '--never-answer'],
          extensions: ['.silent'],
          env: { FAKE_LSP_CANCEL_MARKER: cancelMarker },
        },
      },
    }),
  );
  await writeFile(path.join(root, 'target.silent'), 'const TARGET = 1;\n');
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await tools.execute(call('lsp_start', { language: 'silent' }), ctx());
  assert.equal(started.isError, false, started.content);
  const controller = new AbortController();
  // The request is written synchronously before this timer exists, so aborting cannot race the write: the server
  // has the request by the time it is told to drop it.
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  /**
   * The call *rejects* rather than returning a failed result, and that is the registry's contract for a
   * cancellation: a call the run stopped is not a tool the model is told about. What this test is about is the
   * other end of it — the server must be told which request to drop rather than left computing it.
   */
  await assert.rejects(
    tools.execute(call('lsp_hover', { path: 'target.silent', line: 1, character: 7 }), {
      signal: controller.signal,
      approve: async () => true,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
    'a request its caller abandoned cannot answer',
  );
  await waitForFile(cancelMarker);
  assert.match(
    await readFile(cancelMarker, 'utf8'),
    /^\d+$/m,
    'the server was told which request to drop, not only that the client stopped listening',
  );
});

test('a server whose output cannot be decoded is killed instead of left holding the workspace', async (t) => {
  /**
   * A decode failure marked the client failed and rejected everything pending, and nothing stopped the child. The
   * manager answers `undefined` for a client that is not running, so the next request for that language built a
   * new client and overwrote the map entry: the failed one was never stopped on the way out and its process kept
   * the workspace open for the life of the host. The fixture answers the handshake and then writes bytes that are
   * not a frame, and records its pid so "still running" is a question this test can ask.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspmalformed-'));
  const marker = path.join(root, 'lifecycle');
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        broken: {
          command: process.execPath,
          args: [FIXTURE, '--malformed-output'],
          extensions: ['.broken'],
          env: { FAKE_LSP_LIFECYCLE_MARKER: marker },
        },
      },
    }),
  );
  const tools = createTools(root);
  const pidFile = `${marker}.pid`;
  const childPid = async (): Promise<number> => Number(await readFile(pidFile, 'utf8'));
  t.after(async () => {
    await tools.close();
    // A failed assertion must not leave the fixture running for the rest of the suite.
    try {
      process.kill(await childPid(), 'SIGKILL');
    } catch {
      /* Already gone, which is what the test is about. */
    }
    await rm(root, { recursive: true, force: true });
  });
  const started = await tools.execute(call('lsp_start', { language: 'broken' }), ctx());
  await waitForFile(pidFile);
  const child = await childPid();
  /**
   * The start may report either way and this does not depend on which: the handshake is answered *before* the
   * malformed frame is written, so the failure is the decoder's and it lands whenever the chunk is read.
   */
  assert.equal(typeof started.isError, 'boolean');
  assert.equal(await waitForExit(child), true, 'the process the failed client owned was killed');
  // Killed rather than asked to leave: a stream this client cannot parse is not one it can hold a `shutdown`
  // handshake over, so `exit` never arrived and the tree was terminated.
  await assert.rejects(readFile(`${marker}.exited`), { code: 'ENOENT' });
});

test('the open-document working set is bounded, and a refresh is a change rather than a second open', async (t) => {
  /**
   * Two defects in the same bookkeeping, told apart by what the *server* was sent rather than by what the client
   * believes: the map of open documents grew for the life of the client (every file the session had ever touched,
   * full text, with the server holding it too), and `refreshDocument` deleted its cache entry to force a resend —
   * which announced a document the server already had with a second `didOpen`, the sequence a server is entitled
   * to reject and the one that leaves it holding two copies.
   *
   * The client is driven directly, because this is about messages on the wire and not about any tool's answer.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lspworking-'));
  const marker = path.join(root, 'sync');
  const lifecycle = path.join(root, 'lifecycle');
  t.after(async () => {
    await client.stop().catch(() => undefined);
    // A safety net rather than the mechanism: the fixture writes its own pid, so a failed assertion cannot leave
    // a language server running for the rest of the suite.
    try {
      process.kill(Number(await readFile(`${lifecycle}.pid`, 'utf8')), 'SIGKILL');
    } catch {
      /* Already gone. */
    }
    await rm(root, { recursive: true, force: true });
  });
  const files: string[] = [];
  for (let index = 0; index < 33; index++) {
    const file = path.join(root, `file${index}.fake`);
    await writeFile(file, `const TARGET${index} = ${index};\n`);
    files.push(file);
  }
  const client = new LspClient(
    {
      command: process.execPath,
      args: [FIXTURE],
      language: 'fake',
      extensions: ['.fake'],
      env: { FAKE_LSP_SYNC_MARKER: marker, FAKE_LSP_LIFECYCLE_MARKER: lifecycle },
    },
    root,
  );
  await client.start(new AbortController().signal);
  const signal = new AbortController().signal;
  const syncs = async (): Promise<string[]> =>
    (await readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const linesFor = (list: string[], method: string, file: string): number =>
    list.filter((line) => line.startsWith(`${method} `) && line.endsWith(pathToFileURL(file).href))
      .length;
  /**
   * The marker is written by the *server* as it reads its input, and the client's `sync` only writes to a pipe,
   * so every observation waits for the line it is about instead of racing the fixture.
   */
  const waitFor = async (done: (lines: string[]) => boolean): Promise<string[]> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const lines = await syncs();
      if (done(lines)) return lines;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for the server to report; its last messages were: ${lines.slice(-5).join(' | ')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  for (const file of files.slice(0, 32)) await client.sync(file, signal);
  assert.equal(client.documents, 32, 'the working set holds the documents that were synchronised');
  const opened = await waitFor((lines) => linesFor(lines, 'didOpen', files[31]!) === 1);
  assert.equal(linesFor(opened, 'didClose', files[0]!), 0, 'and nothing has fallen out yet');
  /**
   * The thirty-third is one too many: the oldest document is closed rather than forgotten, so the server releases
   * it too — which is the difference between a bounded cache and a leak that only this process cannot see.
   */
  await client.sync(files[32]!, signal);
  assert.equal(client.documents, 32);
  const afterEviction = await waitFor((lines) => linesFor(lines, 'didClose', files[0]!) === 1);
  assert.equal(linesFor(afterEviction, 'didClose', files[1]!), 0, 'and only the oldest');
  /**
   * And re-synchronising it opens it again rather than sending a change: the server no longer has the document,
   * so a `didChange` would be a violation, and this is what the client's own bookkeeping decides.
   */
  await writeFile(files[0]!, 'const TARGET0 = 99;\n');
  await client.sync(files[0]!, signal);
  const afterReopen = await waitFor((lines) => linesFor(lines, 'didOpen', files[0]!) === 2);
  assert.equal(
    linesFor(afterReopen, 'didChange', files[0]!),
    0,
    'not changed: the server had closed it',
  );
  /**
   * The refresh is the other half: a document the server still has must be re-sent as a change. The text is
   * rewritten out of band first, since an unchanged file is (correctly) not sent at all.
   */
  await writeFile(files[5]!, 'const TARGET5 = 55;\n');
  await client.refreshDocument(files[5]!, signal);
  const afterRefresh = await waitFor((lines) => linesFor(lines, 'didChange', files[5]!) === 1);
  assert.equal(linesFor(afterRefresh, 'didOpen', files[5]!), 1, 'exactly one open, ever');
});

test('a devDependency-installed server runs from its package entry without a shell', async (t) => {
  const { root, tools } = await workspace(t);
  // npm's node_modules/.bin entries are .cmd shims on Windows, which spawn with
  // shell:false cannot execute. The real package entry must be used instead.
  const pkg = path.join(root, 'node_modules', 'fake-ls');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'fake-ls', version: '1.0.0', bin: { 'fake-ls': 'cli.mjs' } }),
  );
  await writeFile(
    path.join(pkg, 'cli.mjs'),
    `import ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n`,
  );
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: {
        local: {
          command: 'fake-ls',
          package: 'fake-ls',
          args: [],
          extensions: ['.local'],
        },
      },
    }),
  );
  await writeFile(path.join(root, 'main.local'), 'const TARGET = 1;\n');
  const { context, approvals } = recording();
  const status = await tools.execute(call('lsp_servers', {}), context);
  assert.match(status.content, /"via": "node_modules\/fake-ls"/);
  const started = await tools.execute(call('lsp_start', { language: 'local' }), context);
  assert.equal(started.isError, false, started.content);
  assert.match(approvals[0]!.description, /Resolved from: node_modules\/fake-ls/);
  assert.match(approvals[0]!.description, /cli\.mjs/, 'the real entry must be shown, not a shim');
  const diagnostics = await tools.execute(
    call('lsp_diagnostics', { paths: ['main.local'] }),
    context,
  );
  assert.equal(diagnostics.isError, false, diagnostics.content);
  assert.equal(diagnostics.content, 'No diagnostics');
});

test('a Windows .cmd shim alone is not reported as an available server', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only shim behaviour');
  const { root, tools } = await workspace(t);
  const bin = path.join(root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'shim-ls.cmd'), '@echo off\r\n');
  await writeFile(
    path.join(root, '.yuantu', 'lsp.json'),
    JSON.stringify({
      servers: { shim: { command: 'shim-ls', args: [], extensions: ['.shim'] } },
    }),
  );
  const status = await tools.execute(call('lsp_servers', {}), ctx());
  assert.match(
    status.content,
    /"language": "shim"[\s\S]*?"available": false/,
    'a .cmd shim cannot be spawned without a shell, so it must not look available',
  );
});

test('edits carry fresh diagnostics only once a server is already running', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'const TARGET = 1;\n');
  // Read before the first edit: a change is refused for a file this run has not read, and the later edits in this
  // test are covered by the observation the first successful change leaves behind.
  assert.equal(
    (await tools.execute(call('read_file', { path: 'main.fake' }), ctx())).isError,
    false,
  );
  const before = await tools.execute(
    call('edit_file', {
      path: 'main.fake',
      old_text: 'const TARGET = 1;',
      new_text: 'const ok = 1;',
    }),
    ctx(),
  );
  assert.equal(before.isError, false, before.content);
  assert.ok(
    !before.content.includes('Language server diagnostics'),
    'editing must not start a server on its own',
  );

  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const clean = await tools.execute(
    call('edit_file', { path: 'main.fake', old_text: 'const ok = 1;', new_text: 'const ok = 2;' }),
    ctx(),
  );
  assert.equal(clean.isError, false, clean.content);
  assert.match(clean.content, /Language server diagnostics:/);
  assert.match(clean.content, /main\.fake: no errors or warnings/);

  const broken = await tools.execute(
    call('edit_file', { path: 'main.fake', old_text: 'const ok = 2;', new_text: 'BADTOKEN' }),
    ctx(),
  );
  assert.equal(broken.isError, false, broken.content);
  assert.match(broken.content, /1:1 error \[fake\/bad-token\]/);
});

test('lsp_rename applies a multi-file WorkspaceEdit atomically and journals it', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'TARGET = 1;\nMULTIFILE\n');
  await writeFile(path.join(root, 'second.fake'), 'TARGET = 2;\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());

  const grouped: FileSnapshot[] = [];
  const applied: string[] = [];
  const approvals: Approval[] = [];
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async (approval: Approval) => {
      approvals.push(approval);
      return true;
    },
    fileJournal: {
      prepare: () => 'single',
      prepareGroup: (change: FileChange, files: FileSnapshot[]) => {
        assert.equal(change.kind, 'batch');
        grouped.push(...files);
        return 'group-1';
      },
      applied: (id: string) => applied.push(id),
    },
  };
  const result = await tools.execute(
    call('lsp_rename', {
      path: 'main.fake',
      line: 1,
      character: 1,
      new_name: 'RENAMED',
    }),
    context,
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(await readFile(path.join(root, 'main.fake'), 'utf8'), 'RENAMED = 1;\nMULTIFILE\n');
  assert.equal(await readFile(path.join(root, 'second.fake'), 'utf8'), 'RENAMED = 2;\n');
  assert.deepEqual(grouped.map((snapshot) => snapshot.path).sort(), ['main.fake', 'second.fake']);
  assert.deepEqual(applied, ['group-1']);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, 'write');
  assert.match(approvals[0]!.description, /second\.fake/);
  assert.equal(result.change?.kind, 'batch');
  assert.equal(result.change?.changes?.length, 2);
});

test('a WorkspaceEdit that also moves a file is refused whole, not half-applied', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'TARGET = 1;\nRENAMEFILE\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const { context, approvals } = recording();
  const result = await tools.execute(
    call('lsp_rename', { path: 'main.fake', line: 1, character: 1, new_name: 'RENAMED' }),
    context,
  );
  /**
   * The server asked for a file move *and* a text edit. Only the text half can be applied here, so the whole
   * edit has to be refused: renaming the references while leaving the file where it was is a workspace state
   * nobody asked for, and the caller would be told the rename succeeded.
   */
  assert.equal(result.isError, true);
  assert.match(result.content, /asks to rename a file/);
  assert.equal(await readFile(path.join(root, 'main.fake'), 'utf8'), 'TARGET = 1;\nRENAMEFILE\n');
  assert.deepEqual(approvals, [], 'nothing may be approved for an edit that will not be applied');
  await assert.rejects(() => stat(path.join(root, 'moved.fake')));
});

test('lsp_rename rejects a position the server cannot rename and a bad name', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'plain.fake'), 'const ok = 1;\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());

  const notRenameable = await tools.execute(
    call('lsp_rename', { path: 'plain.fake', line: 1, character: 1, new_name: 'X' }),
    ctx(),
  );
  assert.equal(notRenameable.isError, true);
  assert.match(notRenameable.content, /not renameable|no effective edits/);

  const badName = await tools.execute(
    call('lsp_rename', { path: 'plain.fake', line: 1, character: 1, new_name: 'two words' }),
    ctx(),
  );
  assert.equal(badName.isError, true);
  assert.match(badName.content, /single identifier/);
});

test('lsp_rename is refused when the user denies the write approval', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'TARGET = 1;\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const { context } = recording(false);
  const result = await tools.execute(
    call('lsp_rename', { path: 'main.fake', line: 1, character: 1, new_name: 'RENAMED' }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Permission denied/);
  assert.equal(await readFile(path.join(root, 'main.fake'), 'utf8'), 'TARGET = 1;\n');
});

test('lsp_code_action lists quick fixes and marks the ones that cannot be applied', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'BADTOKEN here\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());

  const listed = await tools.execute(
    call('lsp_code_action', { path: 'main.fake', line: 1, character: 1 }),
    ctx(),
  );
  assert.equal(listed.isError, false, listed.content);
  assert.match(
    listed.content,
    /^1\. Replace BADTOKEN with GOODTOKEN \[quickfix, preferred, applies\]$/m,
  );
  assert.match(listed.content, /^2\. Run a server command \[quickfix, command-only\]$/m);
  assert.match(listed.content, /^3\. Disabled fix \[quickfix, disabled, no edit\]$/m);

  // kind filters the request the same way an editor's menu does.
  const filtered = await tools.execute(
    call('lsp_code_action', {
      path: 'main.fake',
      line: 1,
      character: 1,
      kind: 'source.organizeImports',
    }),
    ctx(),
  );
  assert.equal(filtered.content, 'No code actions available here');
});

test('lsp_apply_code_action applies the edit atomically and journals it', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'BADTOKEN here\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());

  const grouped: FileSnapshot[] = [];
  const applied: string[] = [];
  const { context, approvals } = recording();
  const journaling: ToolContext = {
    ...context,
    fileJournal: {
      prepare: () => 'single',
      prepareGroup: (_change: FileChange, files: FileSnapshot[]) => {
        grouped.push(...files);
        return 'group-ca';
      },
      applied: (id: string) => applied.push(id),
    },
  };
  const result = await tools.execute(
    call('lsp_apply_code_action', { path: 'main.fake', line: 1, character: 1, index: 1 }),
    journaling,
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(await readFile(path.join(root, 'main.fake'), 'utf8'), 'GOODTOKEN here\n');
  assert.deepEqual(
    grouped.map((snapshot) => snapshot.path),
    ['main.fake'],
  );
  assert.deepEqual(applied, ['group-ca']);
  assert.equal(approvals[0]!.kind, 'write');
  assert.match(approvals[0]!.description, /Apply code action: Replace BADTOKEN with GOODTOKEN/);
  assert.match(approvals[0]!.description, /quickfix/);
});

test('lsp_apply_code_action refuses command-only, disabled and out-of-range actions', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'BADTOKEN here\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const attempt = (index: number) =>
    tools.execute(
      call('lsp_apply_code_action', { path: 'main.fake', line: 1, character: 1, index }),
      ctx(),
    );

  const commandOnly = await attempt(2);
  assert.equal(commandOnly.isError, true);
  assert.match(commandOnly.content, /only carries a server command/);
  assert.match(commandOnly.content, /not supported/);

  const disabled = await attempt(3);
  assert.equal(disabled.isError, true);
  assert.match(disabled.content, /disabled by the server/);

  const outOfRange = await attempt(9);
  assert.equal(outOfRange.isError, true);
  assert.match(outOfRange.content, /out of range/);

  // Nothing may have been written by any refused attempt.
  assert.equal(await readFile(path.join(root, 'main.fake'), 'utf8'), 'BADTOKEN here\n');
});

test('lsp_workspace_symbols searches the workspace and drops outside results', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'TARGET = 1;\n');
  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());

  const found = await tools.execute(call('lsp_workspace_symbols', { query: 'TARGET' }), ctx());
  assert.equal(found.isError, false, found.content);
  assert.match(found.content, /main\.fake:1:1 variable outer\.TARGET/);
  // A server may return a file without a position; report it without one.
  assert.match(found.content, /other\.fake class targetless/);
  assert.ok(
    !found.content.includes('outside'),
    'a symbol outside the workspace must not be reported',
  );

  const narrow = await tools.execute(call('lsp_workspace_symbols', { query: 'helper' }), ctx());
  assert.match(narrow.content, /other\.fake:3:5 function helper/);
  assert.ok(!narrow.content.includes('TARGET'));

  const none = await tools.execute(call('lsp_workspace_symbols', { query: 'nothing' }), ctx());
  assert.equal(none.content, 'No symbols match "nothing"');
});

test('lsp_workspace_symbols needs a server and disambiguates several', async (t) => {
  const { root, tools } = await workspace(t);
  await writeFile(path.join(root, 'main.fake'), 'TARGET = 1;\n');
  const before = await tools.execute(call('lsp_workspace_symbols', { query: 'x' }), ctx());
  assert.equal(before.isError, true);
  assert.match(before.content, /call lsp_start/);

  await tools.execute(call('lsp_start', { language: 'fake' }), ctx());
  const wrong = await tools.execute(
    call('lsp_workspace_symbols', { query: 'x', language: 'typescript' }),
    ctx(),
  );
  assert.equal(wrong.isError, true);
  assert.match(wrong.content, /No running language server for "typescript"/);
  assert.match(wrong.content, /running: fake/);
});

// ---- merged from lsp-real.test.ts ----

/**
 * Integration tests against real language servers.
 *
 * These never run in the default offline suite: each case skips unless its
 * server is actually usable. The fixture-based tests in `lsp.test.ts` cover the
 * protocol; these cover the catalog entries and the real handshake, which is
 * the only way to catch a wrong argv or a rustup proxy whose component is
 * missing. Install a server to get real coverage:
 *
 *   npm install -D typescript-language-server typescript   # or pyright / gopls / rust-analyzer
 */
const call2 = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});
const ctx2 = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

interface Scenario {
  language: string;
  files: Record<string, string>;
  target: string;
  expect: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    language: 'typescript',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      'main.ts': 'export const value: number = "not a number";\n',
    },
    target: 'main.ts',
    expect: /error/,
  },
  {
    language: 'python',
    files: { 'main.py': 'def f() -> int:\n    return "not an int"\n' },
    target: 'main.py',
    expect: /error/,
  },
  {
    language: 'rust',
    files: {
      'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/main.rs': 'fn main() {\n    let _x: i32 = "not a number";\n}\n',
    },
    target: 'src/main.rs',
    expect: /error/,
  },
  {
    language: 'go',
    files: {
      'go.mod': 'module fixture\n\ngo 1.21\n',
      'main.go': 'package main\n\nfunc main() {\n\tvar x int = "not a number"\n\t_ = x\n}\n',
    },
    target: 'main.go',
    expect: /error/,
  },
];

for (const scenario of SCENARIOS)
  test(`the real ${scenario.language} language server starts and reports diagnostics`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `yuantu-real-${scenario.language}-`));
    const tools = createTools(root);
    t.after(async () => {
      await tools.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const [name, content] of Object.entries(scenario.files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }

    // A missing command is a skip. A command that exists but cannot start is
    // also a skip, but the reason is reported so a broken install is visible
    // instead of silently passing.
    const command = {
      typescript: 'typescript-language-server',
      python: 'pyright-langserver',
      go: 'gopls',
      rust: 'rust-analyzer',
    }[scenario.language]!;
    if (!(await findExecutable(command, undefined, root)))
      return t.skip(`${command} is not installed`);

    const started = await tools.execute(
      call2('lsp_start', { language: scenario.language }),
      ctx2(),
    );
    if (started.isError) return t.skip(`${command} could not start: ${started.content}`);

    // Real servers index on first use, so allow the maximum the tool accepts and
    // retry once: a cold rust-analyzer can exceed a single wait window.
    let content = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await tools.execute(
        call2('lsp_diagnostics', { paths: [scenario.target], timeout_ms: 10_000 }),
        ctx2(),
      );
      assert.equal(result.isError, false, result.content);
      content = result.content;
      if (scenario.expect.test(content)) break;
    }
    assert.match(
      content,
      scenario.expect,
      `the real ${scenario.language} server should report a type error in ${scenario.target}`,
    );
  });
