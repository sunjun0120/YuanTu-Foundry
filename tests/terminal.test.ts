/**
 * Terminals: the process-manager family, and the seam that keeps its native dependency optional.
 *
 * The behaviour that matters here is not "a pty echoes bytes" — that is the dependency's job. It is the four
 * things this project decided *around* it: that a terminal belongs to a session scope and not to the run that
 * opened it, that `terminal_open` is refused where commands are confined, that output is a bounded ring read by
 * cursor instead of an accumulating string, and that the native module is imported when a terminal is opened
 * rather than when the tool catalogue is built. A scripted provider drives all of them without a pty, and one
 * guarded test drives the real dependency when it is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTools } from '../packages/tools/index.ts';
import { TerminalSessions } from '../packages/tools/terminal.ts';
import {
  NODE_PTY,
  nodePtyProvider,
  ptyProvider,
  registerPtyProvider,
  type PtyProcess,
  type PtyRequest,
} from '../packages/tools/pty-provider.ts';
import type { ToolContext } from '../packages/protocol/index.ts';
/** One scripted terminal: whatever is written is echoed back, and `kill` ends it. */
class ScriptedProcess implements PtyProcess {
  pid = 4242;
  readonly written: string[] = [];
  readonly signals: string[] = [];
  killed = false;
  readonly request: PtyRequest;
  private data: ((chunk: string) => void) | undefined;
  private exit: ((event: { exitCode: number | null }) => void) | undefined;
  constructor(request: PtyRequest) {
    this.request = request;
  }
  onData(listener: (chunk: string) => void): void {
    this.data = listener;
  }
  onExit(listener: (event: { exitCode: number | null }) => void): void {
    this.exit = listener;
  }
  write(data: string): void {
    this.written.push(data);
    // A terminal echoes. That is the whole reason the tools exist, and it is what the read cursor moves over.
    this.emit(`echo: ${data}`);
  }
  kill(signal?: string): void {
    this.killed = true;
    if (signal) this.signals.push(signal);
    this.emit('\n[exited]\n');
    this.finish(0);
  }
  /** Used by the tests to produce output the run did not type: a prompt, a program's log, an exit. */
  emit(chunk: string): void {
    this.data?.(chunk);
  }
  finish(exitCode: number | null): void {
    this.exit?.({ exitCode });
  }
}
/** Every spawn this provider was asked for, so a test can assert what was launched. */
const spawned: ScriptedProcess[] = [];
const scriptedProvider = {
  name: 'scripted',
  description: 'A scripted terminal for tests.',
  async available() {
    return null;
  },
  async spawn(request: PtyRequest) {
    const child = new ScriptedProcess(request);
    spawned.push(child);
    return child;
  },
};
registerPtyProvider(scriptedProvider);
/** The env is process-wide, so every test restores it before it can affect another file's process. */
function useScriptedProvider(t: test.TestContext): void {
  const previous = process.env.YUANTU_PTY;
  process.env.YUANTU_PTY = 'scripted';
  t.after(() => {
    if (previous === undefined) delete process.env.YUANTU_PTY;
    else process.env.YUANTU_PTY = previous;
    spawned.length = 0;
  });
}
async function setup(t: test.TestContext) {
  useScriptedProvider(t);
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-terminal-'));
  const terminals = new TerminalSessions(root);
  const tools = createTools(root, undefined, 'session-a', undefined, undefined, terminals);
  t.after(async () => {
    terminals.closeAll();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const ctx: ToolContext = { signal: new AbortController().signal, approve: async () => true };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.execute({ id: crypto.randomUUID(), name, arguments: args }, ctx);
    assert.equal(result.isError, false, result.content);
    return result.content;
  };
  const fail = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.execute({ id: crypto.randomUUID(), name, arguments: args }, ctx);
    assert.equal(result.isError, true, `expected ${name} to fail, got: ${result.content}`);
    return result.content;
  };
  return { root, terminals, tools, ctx, call, fail };
}
test('a terminal is opened, typed into and read by cursor', async (t) => {
  const { call } = await setup(t);
  const opened = await call('terminal_open', { cwd: '.' });
  const id = /Terminal (\S+) started/.exec(opened)?.[1];
  assert.ok(id, `terminal_open must name the terminal it opened: ${opened}`);
  assert.match(opened, /keeps running between steps/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.request.columns, 80);
  // The default shell, and the cwd resolved inside the workspace rather than passed through.
  assert.equal(spawned[0]!.request.cwd, path.resolve(spawned[0]!.request.cwd));
  assert.match(await call('terminal_list', {}), new RegExp(id));
  const sent = await call('terminal_send', { id, input: 'echo hello' });
  assert.match(sent, /cursor: \d+/);
  // `enter` defaults to true, because "run this line" is the overwhelmingly common intent. The newline is the
  // platform's: a Windows console wants CR, a POSIX line discipline wants LF.
  assert.match(spawned[0]!.written[0]!, /^echo hello\r?\n?$/);
  assert.equal(spawned[0]!.written[0]!, `echo hello${process.platform === 'win32' ? '\r' : '\n'}`);
  const read = await call('terminal_read', { id, cursor: 0 });
  assert.match(read, /echo: echo hello/);
  const cursor = Number(/cursor (\d+)/.exec(read)?.[1]);
  assert.ok(cursor > 0);
  // A second read from that cursor sees nothing new rather than repeating the screen.
  assert.match(await call('terminal_read', { id, cursor }), /\[no new output\]/);
  // `enter: false` is what a keypress looks like: no newline is appended.
  await call('terminal_send', { id, input: 'y', enter: false });
  assert.equal(spawned[0]!.written[1], 'y');
});
test('a read can wait for output instead of polling', async (t) => {
  const { call, tools, ctx } = await setup(t);
  const id = /Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!;
  const child = spawned[0]!;
  // Started after the read, so the only way for it to return with output is to have waited.
  const pending = tools.execute(
    { id: 'read', name: 'terminal_read', arguments: { id, cursor: 0, wait_ms: 5000 } },
    ctx,
  );
  setTimeout(() => child.emit('READY\n'), 30);
  const result = await pending;
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /READY/);
  assert.match(result.content, /waited: new output arrived/);
});
test('a named program is a program and its arguments are its own argv', async (t) => {
  const { call, fail } = await setup(t);
  const opened = await call('terminal_open', {
    command: 'python3',
    args: ['-i', '-c', 'print("a b")'],
    cwd: '.',
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.request.file, 'python3');
  // Arguments are never joined into a string: `print("a b")` arrives as one argv entry, which is the whole
  // reason the tool takes an array.
  assert.deepEqual(spawned[0]!.request.args, ['-i', '-c', 'print("a b")']);
  assert.match(opened, /python3/);
  // A command line is refused rather than split, because no splitter can guess where the quoting was.
  assert.match(await fail('terminal_open', { command: 'git rebase -i HEAD~3' }), /one program/);
  assert.match(await fail('terminal_open', { args: ['-i'] }), /needs a `command`/);
  // The refusals happen before anything is spawned.
  assert.equal(spawned.length, 1);
});
test('terminals belong to a session scope, and another scope cannot see or touch them', async (t) => {
  const { call, terminals, root } = await setup(t);
  const id = /Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!;
  assert.equal(terminals.list('session-a').length, 1);
  assert.equal(terminals.list('session-b').length, 0);
  // Not "unknown id" but "not yours": the manager reports the same refusal for both, in every method.
  await assert.rejects(terminals.read(id, 'session-b'), /Unknown terminal/);
  assert.throws(() => terminals.send(id, 'session-b', 'ls', true), /Unknown terminal/);
  assert.throws(() => terminals.signal(id, 'session-b', 'SIGINT'), /Unknown terminal/);
  assert.throws(() => terminals.close(id, 'session-b'), /Unknown terminal/);
  // And a registry built for another scope reports it through the tool surface, not just the manager.
  const other = createTools(root, undefined, 'session-b', undefined, undefined, terminals);
  t.after(() => other.close());
  const refused = await other.execute(
    { id: 'read', name: 'terminal_read', arguments: { id, cursor: 0 } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /Unknown terminal/);
});

test('a terminal accepts an existing executable path containing spaces as one program', async (t) => {
  const { call, root } = await setup(t);
  const executable = path.join(root, '中文 program.exe');
  await writeFile(executable, 'scripted executable');
  await call('terminal_open', { command: executable, args: ['argument with spaces'] });
  assert.equal(spawned[0]!.request.file, executable);
  assert.deepEqual(spawned[0]!.request.args, ['argument with spaces']);
});
test('closing a terminal ends it, and an exited terminal refuses input', async (t) => {
  const { call, fail, terminals } = await setup(t);
  const id = /Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!;
  const child = spawned[0]!;
  assert.match(await call('terminal_close', { id }), /closed/);
  assert.equal(child.killed, true);
  assert.equal(terminals.list('session-a')[0]!.status, 'exited');
  assert.match(await fail('terminal_send', { id, input: 'ls' }), /already exited/);
  // Idempotent: closing what is already closed reports the same state instead of failing.
  assert.match(await call('terminal_close', { id }), /closed/);
  // And the exit is readable, which is how a run learns the program is gone.
  assert.match(await call('terminal_read', { id, cursor: 0 }), /exited \(exit 0\)/);
});
test('a terminal that ends on its own is reported as exited with its code', async (t) => {
  const { call } = await setup(t);
  const id = /Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!;
  spawned[0]!.finish(3);
  const read = await call('terminal_read', { id, cursor: 0 });
  assert.match(read, /exited \(exit 3\)/);
  assert.match(await call('terminal_list', {}), /exited \(exit 3\)/);
});
test('SIGINT is typed as the interrupt character, and the other signals go to the process', async (t) => {
  const { call, terminals, fail } = await setup(t);
  const id = /Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!;
  const child = spawned[0]!;
  // The manager refuses a signal the schema would never let through: it is reachable without a registry, and a
  // live terminal is what the check has to see first.
  assert.throws(
    () => terminals.signal(id, 'session-a', 'SIGUSR1' as unknown as 'SIGINT'),
    /must be one of/,
  );
  // Ctrl-C is a byte on the terminal, not a signal to the shell: only the line discipline can deliver it to
  // the foreground job, and on Windows there is no signal delivery at all.
  assert.match(await call('terminal_signal', { id, signal: 'SIGINT' }), /Sent SIGINT/);
  assert.equal(child.written.at(-1), '\x03');
  assert.equal(child.signals.length, 0);
  assert.match(await call('terminal_signal', { id, signal: 'SIGKILL' }), /Sent SIGKILL/);
  assert.deepEqual(child.signals, ['SIGKILL']);
  // A signal the schema does not offer is refused before anything is sent. The schema owns that check, which is
  // why the message is the argument error rather than the tool's own wording.
  assert.match(await fail('terminal_signal', { id, signal: 'SIGUSR1' }), /Invalid arguments/);
});
test('the number of live terminals is capped, and a closed one frees a slot', async (t) => {
  const { call, fail } = await setup(t);
  const opened: string[] = [];
  for (let index = 0; index < 8; index++)
    opened.push(/Terminal (\S+) started/.exec(await call('terminal_open', {}))![1]!);
  assert.match(await fail('terminal_open', {}), /Terminal limit is 8/);
  await call('terminal_close', { id: opened[0]! });
  assert.match(await call('terminal_open', {}), /started/);
});
test('terminal_open is refused where commands are confined to a sandbox', async (t) => {
  const { fail } = await setup(t);
  const previous = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  t.after(() => {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
  });
  assert.match(await fail('terminal_open', {}), /way around the docker sandbox/);
  // Nothing was launched: the refusal happens before the manager reaches a provider.
  assert.equal(spawned.length, 0);
});

test('concurrent terminal opens cannot exceed the live process limit', async (t) => {
  const { tools, ctx, terminals } = await setup(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      tools.execute({ id: crypto.randomUUID(), name: 'terminal_open', arguments: {} }, ctx),
    ),
  );
  assert.equal(results.filter((result) => !result.isError).length, 8);
  assert.equal(terminals.list().filter((terminal) => terminal.status === 'running').length, 8);
});

test('closing a scope joins pending terminal opens and prevents a late process', async (t) => {
  const { ctx, terminals } = await setup(t);
  const opening = terminals.open({}, ctx, 'session-a');
  await terminals.closeAllAndWait('session-a');
  await assert.rejects(opening, /closing|closed/);
  assert.equal(
    terminals.list().some((terminal) => terminal.status === 'running'),
    false,
  );
});

test('one terminal cleanup failure still stops all other owned terminals', async (t) => {
  const { call, terminals } = await setup(t);
  await call('terminal_open', {});
  await call('terminal_open', {});
  const first = spawned[0]!,
    second = spawned[1]!,
    original = first.kill.bind(first);
  first.kill = () => {
    throw new Error('first terminal could not stop');
  };
  try {
    await assert.rejects(terminals.closeAllAndWait(), /first terminal|cleanup/);
    assert.equal(second.killed, true);
  } finally {
    first.kill = original;
    first.kill();
  }
});
test('an unregistered provider is reported by name instead of failing obscurely', async (t) => {
  const { fail } = await setup(t);
  process.env.YUANTU_PTY = 'not-a-provider';
  assert.match(
    await fail('terminal_open', {}),
    /No PTY provider named "not-a-provider" is registered/,
  );
  // The default is the built-in backend, which registers itself at import time without loading the native module.
  delete process.env.YUANTU_PTY;
  assert.equal(ptyProvider().name, NODE_PTY);
});
test('the catalogue only carries the terminal tools when the host supplies a manager', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-terminal-catalogue-'));
  const terminals = new TerminalSessions(root);
  const withTerminals = createTools(root, undefined, 's', undefined, undefined, terminals);
  t.after(async () => {
    await withTerminals.close();
    await rm(root, { recursive: true, force: true });
  });
  const names = withTerminals.specs().map((spec) => spec.name);
  for (const name of [
    'terminal_open',
    'terminal_list',
    'terminal_read',
    'terminal_send',
    'terminal_signal',
    'terminal_close',
  ])
    assert.ok(names.includes(name), `${name} must be in the catalogue when a manager is passed`);
  // Opening and typing are effects on the host; reading and listing are observations of this session's own
  // state, so they are the two that survive the read-only filter — which is also what lets a plan-mode run
  // watch a terminal without being able to start or steer one.
  const readOnly = withTerminals.specs({ readOnly: true }).map((spec) => spec.name);
  assert.ok(readOnly.includes('terminal_list') && readOnly.includes('terminal_read'));
  for (const name of ['terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close'])
    assert.ok(!readOnly.includes(name), `${name} must not survive the read-only filter`);
  const withoutTerminals = createTools(root);
  t.after(() => withoutTerminals.close());
  const bare = withoutTerminals.specs().map((spec) => spec.name);
  for (const name of ['terminal_open', 'terminal_read']) assert.ok(!bare.includes(name));
  const refused = await withoutTerminals.execute(
    { id: 'x', name: 'terminal_open', arguments: {} },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /Unknown tool/);
});
test('the native dependency is imported when a terminal opens, never when the catalogue is built', async () => {
  // A source-level assertion on purpose: `createTools` runs on every host, including hosts that will never open
  // a terminal, so a top-level import of an optional native module would take down every tool in the product
  // when its prebuild is missing. The rule is "dynamic import only", and only the text can state it.
  const source = await readFile(
    new URL('../packages/tools/pty-provider.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    !/^\s*import\s[^\n]*from\s*'@lydell\/node-pty'/m.test(source),
    'pty-provider.ts must not statically import the optional native module',
  );
  assert.equal(
    (source.match(/await import\('@lydell\/node-pty'\)/g) ?? []).length,
    2,
    'both available() and spawn() must import it lazily',
  );
  // Availability is an answer rather than a throw, whichever way it goes on this machine.
  const unavailable = await nodePtyProvider.available();
  assert.ok(
    unavailable === null || /@lydell\/node-pty is not available/.test(unavailable),
    `available() must answer with null or the reason: ${String(unavailable)}`,
  );
});
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

test('a naturally exited native terminal releases its host process', async (t) => {
  const unavailable = await nodePtyProvider.available();
  if (unavailable) return t.skip(unavailable);
  const source = `
    import { nodePtyProvider } from './packages/tools/pty-provider.ts';
    const child = await nodePtyProvider.spawn({ file: process.execPath,
      args: ['-e', "console.log('NATURAL_PTY_DONE')"], cwd: process.cwd(),
      env: process.env, columns: 80, rows: 24 });
    child.onData(chunk => process.stdout.write(chunk));
    child.onExit(event => console.log('NATURAL_EXIT=' + event.exitCode));
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      timeout: 8000,
    },
  );
  assert.match(result.stdout, /NATURAL_PTY_DONE/);
  assert.match(result.stdout, /NATURAL_EXIT=0/);
});
