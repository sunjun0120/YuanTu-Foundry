/**
 * The Windows backend: the confinement is real, so the tests check it against the operating system.
 *
 * A sandbox backend is the one kind of code where a passing unit test proves almost nothing: the property that
 * matters is "the kernel refused this write", and only the kernel can answer. Every assertion below therefore
 * runs a real command through `prepareSandbox` and looks at what actually happened — a file that exists, a
 * process that exited non-zero, an argument that survived the command line. The suite skips itself where the
 * backend cannot run (anything but Windows, or a machine where PowerShell or the token is unavailable), because
 * a test that pretends to check isolation on a platform that has none is worse than no test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkSandboxAvailability,
  cleanupSandbox,
  prepareSandbox,
  sandboxProviders,
} from '../packages/tools/sandbox.ts';
import {
  quoteWindowsArgument,
  windowsCommandLine,
  WINDOWS_SANDBOX_SID,
  workspaceSandboxSid,
} from '../packages/tools/sandbox-windows.ts';
import { applySandboxDefaults } from '../apps/shared/runtime.ts';

const config = { mode: 'windows' as const, image: 'node:24-bookworm-slim' };
/** Runs a prepared plan and resolves with its exit code and captured output. */
function execute(plan: Awaited<ReturnType<typeof prepareSandbox>>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    // stderr is kept, not discarded: when a command line is wrong the launcher's own words ("CreateProcessAsUser
    // The system cannot find the file specified") are the entire diagnosis, and a test that throws them away can
    // only report "exit 1" — which is how a missing program name survived a passing argv test.
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) =>
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const unavailable = await checkSandboxAvailability('windows');
const windows = process.platform === 'win32' && unavailable === null;
const reason = windows
  ? false
  : `the Windows backend is not available here: ${unavailable ?? 'not Windows'}`;

test(
  'a workspace cannot write another workspace that previously received a sandbox grant',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-isolation-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const a = path.join(root, 'a'),
      b = path.join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const first = await prepareSandbox(a, a, 'echo granted> own.txt', undefined, config);
    try {
      assert.equal((await execute(first)).code, 0);
    } finally {
      await cleanupSandbox(first);
    }
    const second = await prepareSandbox(
      b,
      b,
      `echo escaped> "${path.join(a, 'foreign.txt')}"`,
      undefined,
      config,
    );
    try {
      assert.notEqual((await execute(second)).code, 0);
      await assert.rejects(stat(path.join(a, 'foreign.txt')));
    } finally {
      await cleanupSandbox(second);
    }
  },
);

test('the backend is registered with the other built-ins and says what it confines', () => {
  const provider = sandboxProviders().find((candidate) => candidate.mode === 'windows');
  assert.ok(provider, 'windows is a selectable mode, not a special case in the dispatcher');
  assert.match(provider.description, /write/i);
  // The description is what an operator picks a backend by, so it must not claim what the token does not do.
  assert.match(provider.description, /not confined|reads/i);
});
test('the shipped default picks this backend on Windows, and never overrides a choice', () => {
  // The default is the part a person never sees, so it is the part worth pinning: on Windows the CLI and the
  // Host must start confined, while an explicit `YUANTU_SANDBOX` (a test, a carrier, an operator) is left alone.
  const untouched: NodeJS.ProcessEnv = {};
  applySandboxDefaults(untouched);
  if (process.platform === 'win32') {
    assert.equal(untouched.YUANTU_SANDBOX, 'windows');
    // Hooks are pinned to the host in the same breath: they are operator-authored code outside the workspace,
    // and a token (or container) per event is not worth paying for the bridge.
    assert.equal(untouched.YUANTU_SANDBOX_HOOK, 'host');
  } else {
    assert.equal(
      untouched.YUANTU_SANDBOX,
      undefined,
      'no local backend exists on this platform, so the library default stands rather than guessing at Docker',
    );
  }
  const chosen: NodeJS.ProcessEnv = { YUANTU_SANDBOX: 'docker' };
  applySandboxDefaults(chosen);
  assert.deepEqual(chosen, { YUANTU_SANDBOX: 'docker' });
});
test('a cwd outside the workspace is refused before anything runs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareSandbox(root, os.tmpdir(), 'echo hi', undefined, config), /outside/i);
});
test(
  'a command starts under the restricted token, and the identity it runs as is not this process',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plan = await prepareSandbox(root, root, 'echo sandboxed', undefined, config);
    assert.equal(plan.backend, 'windows');
    try {
      const result = await execute(plan);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /sandboxed/);
    } finally {
      await cleanupSandbox(plan);
    }
  },
);
test(
  'writing inside the workspace works and writing outside it does not',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    // Both files exist before the sandbox ever runs: the grant is applied to the workspace root and has to reach
    // what is already there, which is the case every real checkout is in.
    const nested = path.join(root, 'nested');
    const inside = path.join(nested, 'inside.txt');
    await mkdir(nested, { recursive: true });
    await writeFile(inside, 'before');
    await writeFile(path.join(root, 'existing.txt'), 'before');
    t.after(() => rm(root, { recursive: true, force: true }));
    const outside = path.join(os.tmpdir(), `yuantu-escape-${process.pid}.txt`);
    t.after(() => rm(outside, { force: true }));
    const insidePlan = await prepareSandbox(
      root,
      root,
      `echo written> "${inside.replace(/\\/g, '\\\\')}"`,
      undefined,
      config,
    );
    const insideResult = await execute(insidePlan);
    await cleanupSandbox(insidePlan);
    assert.equal(insideResult.code, 0, 'a write to the workspace is allowed');
    assert.equal((await readFile(inside, 'utf8')).trim(), 'written');
    const existingPlan = await prepareSandbox(
      root,
      root,
      'echo changed> existing.txt',
      undefined,
      config,
    );
    const existingResult = await execute(existingPlan);
    await cleanupSandbox(existingPlan);
    assert.equal(existingResult.code, 0, 'a file that predates the sandbox is writable too');
    assert.equal((await readFile(path.join(root, 'existing.txt'), 'utf8')).trim(), 'changed');

    const escapePlan = await prepareSandbox(
      root,
      root,
      `echo escaped> "${outside.replace(/\\/g, '\\\\')}"`,
      undefined,
      config,
    );
    const escapeResult = await execute(escapePlan);
    await cleanupSandbox(escapePlan);
    assert.notEqual(escapeResult.code, 0, 'a write outside the workspace is refused');
    await assert.rejects(stat(outside), 'and the file is not there afterwards');
  },
);
test('the exit code is the command’s, not the launcher’s', { skip: reason }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [command, expected] of [
    ['exit 7', 7],
    ['exit 0', 0],
  ] as const) {
    const plan = await prepareSandbox(root, root, command, undefined, config);
    try {
      assert.equal((await execute(plan)).code, expected, `\`${command}\` reported its own code`);
    } finally {
      await cleanupSandbox(plan);
    }
  }
});
test(
  'the starter script is identical for every command, so the platform does not re-scan it',
  { skip: reason },
  async (t) => {
    // Measured rather than assumed: the first version embedded the command in the script and cost 2.1s per
    // command against 0.44s for the same script twice, because this platform caches its verdict on a script by
    // its text (appending a single comment character brought the 1.7s penalty back). Per-command data therefore
    // travels in the environment, and this pins the split: identical arguments, different environment.
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = await prepareSandbox(root, root, 'echo one', undefined, config);
    const second = await prepareSandbox(root, root, 'echo two', undefined, config);
    try {
      assert.deepEqual(first.args, second.args);
      assert.notDeepEqual(first.env, second.env);
    } finally {
      await cleanupSandbox(first);
      await cleanupSandbox(second);
    }
  },
);
test(
  'an argv survives the command line with quotes and trailing backslashes intact',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    // Program and arguments, the way `prepareSandbox` is called by the real argv callers (`acceptance.ts`):
    // the third parameter is the image and the fourth is what follows it — *not* an argv that repeats the
    // program, which is how this test was first written and which is why it passed while the path was broken.
    const args = [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'plain',
      'with space',
      'quote"inside',
      'trailing\\',
      'back\\\\slash',
      '',
    ];
    const plan = await prepareSandbox(root, root, process.execPath, args, config);
    try {
      const result = await execute(plan);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args.slice(2));
    } finally {
      await cleanupSandbox(plan);
    }
  },
);
test('the quoting rule is the one Windows de-parses', () => {
  // Not a style check: the launcher hands `CreateProcessAsUser` one string that the child parses back into
  // arguments, so every quote and backslash here is a chance to change what a command *means*. The vectors are
  // the documented rules — a quote is escaped as `\"`, and backslashes are doubled only when they precede one
  // or the closing quote. The end-to-end proof is the argv test above, which runs a real process.
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a b'), '"a b"');
  assert.equal(quoteWindowsArgument('q"q'), '"q\\"q"');
  // Unquoted, a trailing backslash is literal; inside quotes it has to be doubled or it would escape the quote.
  assert.equal(quoteWindowsArgument('trail\\'), 'trail\\');
  assert.equal(quoteWindowsArgument('a b\\'), '"a b\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteWindowsArgument('back\\\\slash'), 'back\\\\slash');
  // The shell form is quoted too: the command runs under `cmd /d /s /c` with the outer quotes intact, so a
  // command string that contains quotes of its own cannot change where the wrapper ends.
  assert.equal(
    windowsCommandLine({ command: 'echo hi' }),
    `${process.env.ComSpec ?? 'cmd.exe'} /d /s /c "echo hi"`,
  );
  // The argv form leads with the image: `CreateProcess` takes the first token as the program, so leaving it out
  // produced a command line starting with `-e` (nothing to run) while every other assertion here still held.
  assert.equal(windowsCommandLine({ command: 'prog', argv: ['a b', 'c'] }), 'prog "a b" c');
  assert.equal(
    windowsCommandLine({ command: 'C:\\Program Files\\node.exe', argv: ['-e', 'x'] }),
    '"C:\\Program Files\\node.exe" -e x',
  );
});
test('an unavailable backend reports itself rather than falling back to the host', async () => {
  if (process.platform === 'win32' && unavailable === null) {
    // On this machine the backend works, so the refusal path is the only part that can be checked here: a
    // workspace the grant cannot reach (a directory that does not exist) must fail, not run unconfined.
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(
      prepareSandbox(root, root, 'echo hi', undefined, config),
      (error: Error) => !/No sandbox provider/.test(error.message),
    );
    return;
  }
  assert.ok(unavailable, 'on this platform the backend cannot run and must say so');
  // The message names a way out rather than leaving the operator to guess.
  assert.match(unavailable, /docker|sbx|host/);
  await assert.rejects(
    prepareSandbox(os.tmpdir(), os.tmpdir(), 'echo hi', undefined, config),
    new RegExp(unavailable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'preparing must fail with that answer instead of quietly producing a host plan',
  );
});
test('workspace write identities are stable and distinct; the legacy shared SID is never the workspace identity', () => {
  assert.equal(WINDOWS_SANDBOX_SID, 'S-1-5-12');
  assert.equal(workspaceSandboxSid('a'), workspaceSandboxSid('a'));
  assert.notEqual(workspaceSandboxSid('a'), workspaceSandboxSid('b'));
  assert.notEqual(workspaceSandboxSid('a'), WINDOWS_SANDBOX_SID);
});

test(
  'ambient Everyone write ACLs remain a declared partial boundary',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-ambient-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'),
      ambient = path.join(root, 'ambient');
    await mkdir(workspace);
    await mkdir(ambient);
    await promisify(execFile)('icacls.exe', [ambient, '/grant', '*S-1-1-0:(OI)(CI)M', '/Q']);
    const outside = path.join(ambient, 'outside.txt');
    const plan = await prepareSandbox(
      workspace,
      workspace,
      `echo ambient> "${outside}"`,
      undefined,
      config,
    );
    try {
      assert.equal((await execute(plan)).code, 0);
      assert.equal((await readFile(outside, 'utf8')).trim(), 'ambient');
    } finally {
      await cleanupSandbox(plan);
    }
  },
);
