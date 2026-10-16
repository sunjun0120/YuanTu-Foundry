// @test-serial real-pty: Creates native terminals and console process trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { TerminalSessions } from '../packages/tools/terminal.ts';
import { nodePtyProvider } from '../packages/tools/pty-provider.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

test('a real terminal runs a command end to end', async (t) => {
  const unavailable = await nodePtyProvider.available();
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const previous = process.env.YUANTU_PTY;
  delete process.env.YUANTU_PTY;
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-terminal-real-'));
  const terminals = new TerminalSessions(root);
  t.after(async () => {
    terminals.closeAll();
    if (previous !== undefined) process.env.YUANTU_PTY = previous;
    // A killed console can hold its working directory for a moment on Windows, and the directory it holds is
    // this temporary workspace, so removing it is retried rather than raced.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const context: ToolContext = { signal: new AbortController().signal, approve: async () => true };
  const [open, , read, send, , close] = terminals.tools('real');
  const opened = await open!.execute!({ cwd: '.' }, context);
  assert.equal(opened.isError, false, opened.content);
  const id = /Terminal (\S+) started/.exec(opened.content)![1]!;
  const marker = `yuantu-terminal-${Date.now()}`;
  const sent = await send!.execute!({ id, input: `echo ${marker}` }, context);
  assert.equal(sent.isError, false, sent.content);
  let seen = '';
  let cursor = 0;
  for (let attempt = 0; attempt < 20 && !seen.includes(marker); attempt++) {
    const result = await read!.execute!({ id, cursor, wait_ms: 1000 }, context);
    assert.equal(result.isError, false, result.content);
    seen += result.content;
    // The cursor is what makes the next read a *wait*: a read that has output to return answers immediately,
    // which is the whole point of paging a terminal instead of dumping its screen.
    cursor = Number(/cursor (\d+)/.exec(result.content)![1]);
  }
  assert.match(seen, new RegExp(marker), `the shell must print what it was told: ${seen}`);
  const closed = await close!.execute!({ id }, context);
  assert.equal(closed.isError, false, closed.content);
});

test('a real terminal signal reports what this platform can actually deliver', async (t) => {
  const unavailable = await nodePtyProvider.available();
  if (unavailable) return t.skip(unavailable);
  const previous = process.env.YUANTU_PTY;
  delete process.env.YUANTU_PTY;
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-terminal-signal-'));
  const terminals = new TerminalSessions(root);
  t.after(async () => {
    terminals.closeAll();
    if (previous !== undefined) process.env.YUANTU_PTY = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const context: ToolContext = { signal: new AbortController().signal, approve: async () => true };
  const [open, , read, , signal, close] = terminals.tools('real');
  const source = [
    "process.on('SIGTERM', () => { console.log('SIGTERM_CAUGHT'); process.exit(0); });",
    "console.log('SIGNAL_READY');",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const opened = await open!.execute!(
    { command: process.execPath, args: ['-e', source], cwd: '.' },
    context,
  );
  assert.equal(opened.isError, false, opened.content);
  const id = /Terminal (\S+) started/.exec(opened.content)![1]!;
  let seen = '';
  let cursor = 0;
  // The handler has to be installed before the signal, or the child dies from the default action and the test
  // would pass for the wrong reason.
  for (let attempt = 0; attempt < 20 && !seen.includes('SIGNAL_READY'); attempt++) {
    const result = await read!.execute!({ id, cursor, wait_ms: 1000 }, context);
    assert.equal(result.isError, false, result.content);
    seen += result.content;
    cursor = Number(/cursor (\d+)/.exec(result.content)![1]);
  }
  assert.match(
    seen,
    /SIGNAL_READY/,
    `the terminal must be running before it is signalled: ${seen}`,
  );
  const sent = await signal!.execute!({ id, signal: 'SIGTERM' }, context);
  assert.equal(sent.isError, false, sent.content);
  if (process.platform === 'win32') {
    // A Windows console has no POSIX signal delivery, so the honest answer names the limitation rather than
    // promising a SIGTERM nobody received. The tree is still ended, and the tool waits for that.
    assert.match(sent.content, /SIGTERM was not delivered/);
    assert.doesNotMatch(sent.content, /Sent SIGTERM/);
  } else {
    assert.match(sent.content, /Sent SIGTERM/);
    // POSIX is where the promise can be kept, and the proof is the program's own handler running.
    let after = '';
    for (let attempt = 0; attempt < 40 && !after.includes('SIGTERM_CAUGHT'); attempt++) {
      const result = await read!.execute!({ id, cursor, wait_ms: 250 }, context);
      assert.equal(result.isError, false, result.content);
      after += result.content;
      cursor = Number(/cursor (\d+)/.exec(result.content)![1]);
      if (!after.includes('SIGTERM_CAUGHT'))
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(after, /SIGTERM_CAUGHT/, `SIGTERM must reach the program: ${after}`);
  }
  const closed = await close!.execute!({ id }, context);
  assert.equal(closed.isError, false, closed.content);
});

test('a naturally exited native terminal releases its host process', async (t) => {
  const unavailable = await nodePtyProvider.available();
  if (unavailable) return t.skip(unavailable);
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-natural-pty-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = `
    import { nodePtyProvider } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../packages/tools/pty-provider.ts')).href)};
    const child = await nodePtyProvider.spawn({ file: process.execPath,
      args: ['-e', "console.log('NATURAL_PTY_DONE')"], cwd: process.cwd(),
      env: process.env, columns: 80, rows: 24 });
    child.onData(chunk => process.stdout.write(chunk));
    child.onExit(event => console.log('NATURAL_EXIT=' + event.exitCode));
  `;
  const entry = path.join(root, 'natural-exit.mjs');
  // A file entry avoids propagating --input-type=module into node-pty's file-based worker.
  await writeFile(entry, source);
  const result = await promisify(execFile)(process.execPath, [entry], {
    cwd: path.resolve(import.meta.dirname, '..'),
    timeout: 8000,
  });
  assert.match(result.stdout, /NATURAL_PTY_DONE/);
  assert.match(result.stdout, /NATURAL_EXIT=0/);
});
