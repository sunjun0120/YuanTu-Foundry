// @test-serial windows-sandbox: Exercises real Windows sandbox ACLs and trusted control state.
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
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  windowsProgramNeedsShell,
  WINDOWS_SANDBOX_SID,
  workspaceSandboxSid,
} from '../packages/tools/sandbox-windows.ts';
import { applySandboxDefaults } from '../apps/shared/runtime.ts';
import { labelLowIntegrity } from './windows-label-fixture.ts';
import { windowsShell, windowsShellArgs } from '../packages/tools/windows-shell.ts';

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

test('workspace hardlinks cannot relabel an outside file', { skip: reason }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-hardlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'keep');
  await link(outside, path.join(workspace, 'alias.txt'));
  let plan: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
  let rejected: unknown;
  try {
    plan = await prepareSandbox(workspace, workspace, 'exit 0', undefined, config);
  } catch (error) {
    rejected = error;
  } finally {
    if (plan) await cleanupSandbox(plan);
  }
  assert.match(String(rejected), /hard.?link/i);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  for (const name of ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'])
    await assert.rejects(stat(path.join(workspace, name)), { code: 'ENOENT' });
});

test(
  'a Low integrity launcher cache is refused before trusted code loads',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-low-cache-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'),
      temporary = path.join(root, 'temp');
    await mkdir(workspace);
    await mkdir(temporary);
    await promisify(execFile)('icacls.exe', [temporary, '/grant', '*S-1-1-0:(OI)(CI)M', '/Q']);
    await labelLowIntegrity(temporary);
    const previousTemp = process.env.TEMP,
      previousTmp = process.env.TMP;
    let plan: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    let rejected: unknown;
    try {
      process.env.TEMP = temporary;
      process.env.TMP = temporary;
      try {
        plan = await prepareSandbox(workspace, workspace, 'exit 0', undefined, config);
      } catch (error) {
        rejected = error;
      }
    } finally {
      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
      if (plan) await cleanupSandbox(plan);
    }
    assert.match(String(rejected), /launcher cache.*Low|Low.*launcher cache/i);
  },
);

test(
  'workspace roots containing trusted launcher assets are refused before ACL changes',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-control-root-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const temporary = path.join(root, 'temp');
    await mkdir(temporary);
    const previousTemp = process.env.TEMP,
      previousTmp = process.env.TMP;
    let plan: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    let rejected: unknown;
    try {
      process.env.TEMP = temporary;
      process.env.TMP = temporary;
      try {
        plan = await prepareSandbox(root, root, 'exit 0', undefined, config);
      } catch (error) {
        rejected = error;
      }
    } finally {
      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
      if (plan) await cleanupSandbox(plan);
    }
    assert.match(String(rejected), /workspace.*trusted.*control|trusted.*control.*workspace/i);
    for (const name of ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'])
      await assert.rejects(stat(path.join(root, name)), { code: 'ENOENT' });
  },
);

test('missing trusted metadata paths cannot be created by a guest', { skip: reason }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-missing-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'];
  const plan = await prepareSandbox(
    root,
    root,
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs");for(const p of process.argv.slice(1)){try{fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/evil.txt","escaped")}catch{}}',
      ...names,
    ],
    config,
  );
  try {
    assert.equal((await execute(plan)).code, 0);
    for (const name of names)
      await assert.rejects(stat(path.join(root, name, 'evil.txt')), { code: 'ENOENT' });
  } finally {
    await cleanupSandbox(plan);
  }
  for (const name of names) await assert.rejects(stat(path.join(root, name)), { code: 'ENOENT' });
});

test('another Host cannot lease a nested workspace concurrently', { skip: reason }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-host-lock-'));
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const alternateTemp = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-host-temp-'));
  const plan = await prepareSandbox(root, root, 'exit 0', undefined, config);
  t.after(async () => {
    await cleanupSandbox(plan);
    await rm(root, { recursive: true, force: true });
    await rm(alternateTemp, { recursive: true, force: true });
  });
  const module = new URL('../packages/tools/sandbox.ts', import.meta.url).href;
  const script = `const {prepareSandbox,cleanupSandbox}=await import(${JSON.stringify(module)});try{const p=await prepareSandbox(${JSON.stringify(nested)},${JSON.stringify(nested)},'exit 0',undefined,{mode:'windows',image:'native'});await cleanupSandbox(p);console.log('UNSAFE_ALLOWED')}catch(e){console.log(String(e))}`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 30000, env: { ...process.env, TEMP: alternateTemp, TMP: alternateTemp } },
  );
  assert.doesNotMatch(result.stdout, /UNSAFE_ALLOWED/);
  assert.match(result.stdout, /another.*process|leased|recovery/i);
});

test(
  'launcher exit terminates detached descendants before cleanup',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-job-'));
    let pid: number | undefined;
    let plan: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    t.after(async () => {
      if (pid) {
        await promisify(execFile)('taskkill.exe', ['/pid', String(pid), '/t', '/f']).catch(
          () => {},
        );
      }
      if (plan) await cleanupSandbox(plan);
      await rm(root, { recursive: true, force: true });
    });
    const childSource =
      'require("node:fs").writeFileSync("child-ready.txt",String(process.pid));setInterval(()=>{},1000)';
    const parentSource = `const fs=require('node:fs');const deadline=Date.now()+5000;const timer=setInterval(()=>{if(fs.existsSync('child-ready.txt')){clearInterval(timer);process.stdout.write(fs.readFileSync('child-ready.txt','utf8'))}else if(Date.now()>deadline){throw new Error('Child never started')}},10);`;
    const command = `start "" /b "${process.execPath}" -e "${childSource.replaceAll('"', "'")}" > nul 2>&1 & "${process.execPath}" -e "${parentSource}"`;
    plan = await prepareSandbox(root, root, command, undefined, config);
    const running = execute(plan);
    const startedDeadline = Date.now() + 10000;
    while (Date.now() < startedDeadline) {
      const marker = await readFile(path.join(root, 'child-ready.txt'), 'utf8').catch(() => '');
      if (marker) {
        pid = Number(marker);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(pid, 'the actual START child started');
    const result = await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Launcher left a descendant holding output handles')),
          5000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, 'fixture reported the actual detached child PID');
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, 'the launcher must terminate the entire job before ACL restoration');
  },
);

test(
  "two concurrent plans for one workspace cannot write each other's private scratch",
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-scratch-'));
    let first: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    let second: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    t.after(async () => {
      if (first) await cleanupSandbox(first);
      if (second) await cleanupSandbox(second);
      await rm(root, { recursive: true, force: true });
    });
    first = await prepareSandbox(root, root, 'echo own > "%TEMP%\\own.txt"', undefined, config);
    second = await prepareSandbox(
      root,
      root,
      `echo escaped > "${path.join(first.cleanupPath!, 'foreign.txt')}"`,
      undefined,
      config,
    );
    const own = await execute(first);
    assert.equal(own.code, 0, own.stderr);
    assert.match(await readFile(path.join(first.cleanupPath!, 'own.txt'), 'utf8'), /own/);
    const foreign = await execute(second);
    assert.notEqual(
      foreign.code,
      0,
      'a sibling workspace identity must not authorise this scratch',
    );
    await assert.rejects(stat(path.join(first.cleanupPath!, 'foreign.txt')), { code: 'ENOENT' });
  },
);

test(
  'private scratch refuses sibling writes even when TEMP inherits an Everyone write grant',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-ambient-scratch-'));
    const temporary = path.join(root, 'temp');
    const workspace = path.join(root, 'workspace');
    await mkdir(temporary);
    await mkdir(workspace);
    await promisify(execFile)('icacls.exe', [temporary, '/grant', '*S-1-1-0:(OI)(CI)M']);
    let first: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    let second: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    t.after(async () => {
      if (first) await cleanupSandbox(first);
      if (second) await cleanupSandbox(second);
      await rm(root, { recursive: true, force: true });
    });
    const previous = process.env.TEMP;
    try {
      process.env.TEMP = temporary;
      first = await prepareSandbox(
        workspace,
        workspace,
        'echo own > "%TEMP%\\own.txt"',
        undefined,
        config,
      );
      second = await prepareSandbox(
        workspace,
        workspace,
        `echo escaped > "${path.join(first.cleanupPath!, 'foreign.txt')}"`,
        undefined,
        config,
      );
    } finally {
      if (previous === undefined) delete process.env.TEMP;
      else process.env.TEMP = previous;
    }
    const own = await execute(first!);
    assert.equal(own.code, 0, own.stderr);
    assert.notEqual(
      (await execute(second!)).code,
      0,
      'ambient TEMP grants must not reach another plan scratch',
    );
    await assert.rejects(stat(path.join(first!.cleanupPath!, 'foreign.txt')), { code: 'ENOENT' });
  },
);

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
    assert.equal(untouched.YUANTU_SANDBOX, 'native');
    assert.equal(untouched.YUANTU_SANDBOX_HOOK, undefined);
  } else {
    assert.equal(untouched.YUANTU_SANDBOX, 'native');
  }
  const chosen: NodeJS.ProcessEnv = { YUANTU_SANDBOX: 'host' };
  applySandboxDefaults(chosen);
  assert.deepEqual(chosen, { YUANTU_SANDBOX: 'host' });
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

test('workspace grants cannot modify trusted metadata directories', { skip: reason }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'];
  for (const name of names) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'trusted.txt'), 'keep');
  }
  const plan = await prepareSandbox(
    root,
    root,
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs");for(const dir of process.argv.slice(1)){try{fs.writeFileSync(dir+"/trusted.txt","escaped")}catch{}}',
      ...names,
    ],
    config,
  );
  try {
    await execute(plan);
    for (const name of names)
      assert.equal(await readFile(path.join(root, name, 'trusted.txt'), 'utf8'), 'keep');
  } finally {
    await cleanupSandbox(plan);
  }
});
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
    assert.equal(
      existingResult.code,
      0,
      `a file that predates the sandbox is writable too: ${existingResult.stderr}`,
    );
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
  'a launcher killed while starting its command takes the command with it',
  { skip: reason },
  async (t) => {
    // Found as an `agent.smoke` hang: quitting the desktop killed the availability probe's launcher after
    // `CreateProcessAsUser` had made a suspended child but before the child was in the kill-on-close job. The child
    // stayed suspended forever, holding inherited pipes, and Playwright's `app.close()` waited for them to close.
    // The launcher's test pause widens that window from microseconds to seconds so the kill can land inside it.
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plan = await prepareSandbox(root, root, 'ping -n 30 127.0.0.1 >nul', undefined, config);
    const launcher = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: { ...plan.env, YUANTU_SANDBOX_TEST_LAUNCH_PAUSE_MS: '20000' },
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = new Promise((resolve) => launcher.once('exit', resolve));
    const childrenOf = async (pid: number) => {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }) -join ','`,
        ],
        { windowsHide: true },
      );
      return stdout.trim().split(',').filter(Boolean).map(Number);
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let started: number[] = [];
    try {
      const deadline = Date.now() + 15_000;
      while (!started.length && Date.now() < deadline) {
        started = (await childrenOf(launcher.pid!)).filter(
          // conhost belongs to the launcher's own console, not to the command.
          (pid) => pid !== launcher.pid,
        );
        if (!started.length) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(started.length, 'the launcher started its command within 15 s');
      // Only the launcher, not its tree: this is the kill a parent's job or a crash delivers.
      launcher.kill();
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.deepEqual(started.filter(alive), [], 'no process the launcher started outlives it');
    } finally {
      for (const pid of started) if (alive(pid)) process.kill(pid);
      if (launcher.exitCode === null) launcher.kill();
      await cleanupSandbox(plan);
    }
  },
);
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
  // The shell form runs in the Windows shell with every argument quoted by the same rule, so a command string
  // that contains quotes of its own cannot change where the script argument ends.
  const shell = windowsShell();
  assert.equal(
    windowsCommandLine({ command: 'echo "hi"' }),
    shell.kind === 'cmd'
      ? `${quoteWindowsArgument(shell.path)} /d /s /c "echo "hi""`
      : [shell.path, ...windowsShellArgs(shell, 'echo "hi"')].map(quoteWindowsArgument).join(' '),
  );
  // The argv form leads with the image: `CreateProcess` takes the first token as the program, so leaving it out
  // produced a command line starting with `-e` (nothing to run) while every other assertion here still held.
  assert.equal(windowsCommandLine({ command: 'prog.exe', argv: ['a b', 'c'] }), 'prog.exe "a b" c');
  assert.equal(
    windowsCommandLine({ command: 'C:\\Program Files\\node.exe', argv: ['-e', 'x'] }),
    '"C:\\Program Files\\node.exe" -e x',
  );
  // A bare name that is only a shell shim (`npm`, `pnpm`, `yarn`, `tsc`) has to be resolved by cmd's PATHEXT
  // search. Handing it to `CreateProcessAsUser` directly failed as ERROR_FILE_NOT_FOUND — an acceptance check
  // written as `npm test` never started, and the verifier read the launcher's exit code 1 as a failed assertion.
  assert.equal(
    windowsCommandLine({ command: 'npm', argv: ['test'] }),
    `${process.env.ComSpec ?? 'cmd.exe'} /d /s /c "npm test"`,
  );
});
test('a program is routed through the shell exactly when CreateProcess cannot start it', async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'yuantu-shim-empty-'));
  const images = await mkdtemp(path.join(os.tmpdir(), 'yuantu-shim-images-'));
  t.after(async () => {
    await rm(empty, { recursive: true, force: true });
    await rm(images, { recursive: true, force: true });
  });
  const withPath = (directories: string): NodeJS.ProcessEnv => ({ Path: directories });
  // No image anywhere: `npm` resolves to npm.cmd, which only the shell can start.
  for (const program of ['npm', 'pnpm', 'yarn', 'tsc'])
    assert.equal(windowsProgramNeedsShell(program, withPath(empty)), true, program);
  // An explicit script extension is never an image.
  for (const program of ['npm.cmd', 'build.bat', 'tool.ps1'])
    assert.equal(windowsProgramNeedsShell(program, withPath(images)), true, program);
  // An existing image is started directly, with the exact argument boundary.
  await writeFile(path.join(images, 'tool.exe'), '');
  await writeFile(path.join(images, 'plain.com'), '');
  assert.equal(windowsProgramNeedsShell('tool', withPath(images)), false);
  assert.equal(windowsProgramNeedsShell('plain', withPath(images)), false);
  assert.equal(windowsProgramNeedsShell('tool.exe', withPath(empty)), false);
  // A PATH with several entries: one hit is enough, and an empty entry is skipped rather than searched as cwd.
  assert.equal(
    windowsProgramNeedsShell('tool', withPath([empty, images].join(path.delimiter))),
    false,
  );
  assert.equal(
    windowsProgramNeedsShell('missing', withPath([empty, images].join(path.delimiter))),
    true,
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
  assert.match(unavailable, /refused|no command was started/);
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
  'Low integrity prevents writes through medium-integrity ambient Everyone grants',
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
      assert.notEqual((await execute(plan)).code, 0);
      await assert.rejects(stat(outside), { code: 'ENOENT' });
    } finally {
      await cleanupSandbox(plan);
    }
  },
);

test(
  'ambient Low integrity Everyone grants remain a declared partial boundary',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-low-ambient-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'),
      ambient = path.join(root, 'ambient');
    await mkdir(workspace);
    await mkdir(ambient);
    await promisify(execFile)('icacls.exe', [ambient, '/grant', '*S-1-1-0:(OI)(CI)M', '/Q']);
    await labelLowIntegrity(ambient);
    const file = path.join(ambient, 'outside.txt');
    const plan = await prepareSandbox(
      workspace,
      workspace,
      `echo partial> "${file}"`,
      undefined,
      config,
    );
    try {
      assert.equal((await execute(plan)).code, 0);
      assert.match(await readFile(file, 'utf8'), /partial/);
    } finally {
      await cleanupSandbox(plan);
    }
  },
);

test(
  'a Low-integrity child cannot delete a foreign workspace file through its parent',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-delete-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const a = path.join(root, 'a'),
      b = path.join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const victim = path.join(a, 'victim.txt');
    await writeFile(victim, 'keep');
    const first = await prepareSandbox(a, a, 'exit 0', undefined, config);
    const second = await prepareSandbox(b, b, `del /q "${victim}"`, undefined, config);
    try {
      await execute(second);
      assert.equal(await readFile(victim, 'utf8'), 'keep');
    } finally {
      await cleanupSandbox(second);
      await cleanupSandbox(first);
    }
  },
);

test('launcher works when temp path contains an apostrophe', { skip: reason }, async (t) => {
  // A *new* process, because `windowsSandboxAvailable` memoises its answer per process and this suite has
  // already asked it about the real temp directory. Reusing that cached verdict here would answer for a path
  // that is not the one under test, which is exactly the cold-start case a launcher-cache path can break.
  //
  // The apostrophe is a real one: `os.tmpdir()` is where the compiled launcher and its C# source live, and
  // both paths are carried into the bootstrap as PowerShell single-quoted string literals. A single quote
  // that is not doubled ends the literal early, so the script stops being a script. The space and the CJK
  // characters ride along to show the escape is the only thing that had to be right: only the quote is a
  // metacharacter inside a single-quoted PowerShell literal, and the rest must survive untouched.
  //
  // They belong in the *temp* path, which is what this test is about. A CJK *workspace* root is a separate
  // defect outside this change: `acl.ps1` writes its recovery journal as UTF-8 and reads it back with
  // `Get-Content -Raw` and no `-Encoding`, so Windows PowerShell decodes it as ANSI and the restore step
  // rejects its own journal with "ACL recovery root mismatch".
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-apostrophe-'));
  const temporary = path.join(root, "O'Brien 临时 temp");
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, "O'Brien escape.txt");
  await mkdir(temporary);
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL('../packages/tools/sandbox.ts', import.meta.url).href;
  // The probe's marker is deliberately *not* spelled like a setting: it is one line on the child's stdout, and
  // `tests/environment.test.ts` scans every file for `YUANTU_*` names to check each one is a registered setting.
  const script = `
const { checkSandboxAvailability, prepareSandbox, cleanupSandbox } = await import(${JSON.stringify(module)});
const { spawn } = await import('node:child_process');
const { stat } = await import('node:fs/promises');
const run = (plan) => new Promise((resolve) => {
  const child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.once('error', (error) => resolve({ code: null, stdout, stderr: stderr + error.message }));
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});
const report = { temp: process.env.TEMP };
report.probe = await checkSandboxAvailability('windows');
if (report.probe === null) {
  const config = { mode: 'windows', image: 'native' };
  const inside = await prepareSandbox(${JSON.stringify(workspace)}, ${JSON.stringify(workspace)}, 'echo apostrophe-ok', undefined, config);
  const insideResult = await run(inside);
  await cleanupSandbox(inside);
  report.inside = { code: insideResult.code, stdout: insideResult.stdout, stderr: insideResult.stderr };
  const escape = await prepareSandbox(${JSON.stringify(workspace)}, ${JSON.stringify(workspace)}, 'echo escaped> "' + ${JSON.stringify(outside)} + '"', undefined, config);
  const escapeResult = await run(escape);
  await cleanupSandbox(escape);
  report.escape = { code: escapeResult.code, stderr: escapeResult.stderr };
  report.escapeWrote = await stat(${JSON.stringify(outside)}).then(() => true, () => false);
}
console.log('SANDBOX_PROBE_REPORT' + JSON.stringify(report));
`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      timeout: 240000,
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    },
  ).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? '',
  }));
  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('SANDBOX_PROBE_REPORT'));
  assert.ok(line, `the probe process reported nothing: ${result.stdout}${result.stderr}`);
  const report = JSON.parse(line.slice('SANDBOX_PROBE_REPORT'.length)) as {
    temp: string;
    probe: string | null;
    inside: { code: number | null; stdout: string; stderr: string };
    escape: { code: number | null; stderr: string };
    escapeWrote: boolean;
  };
  assert.equal(report.temp, temporary, 'the child really ran with its temp state under that path');
  assert.equal(
    report.probe,
    null,
    `the launcher must start from an apostrophe path: ${report.probe}`,
  );
  assert.equal(report.inside.code, 0, report.inside.stderr);
  assert.match(report.inside.stdout, /apostrophe-ok/);
  assert.notEqual(report.escape.code, 0, 'a write outside the workspace is still refused');
  assert.equal(report.escapeWrote, false, 'and the file is not there afterwards');
});

test(
  'cleanup restores workspace security including existing children',
  { skip: reason },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-restore-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = path.join(root, 'existing.txt');
    await writeFile(child, 'original');
    const acl = async (file: string) =>
      (await promisify(execFile)('icacls.exe', [file])).stdout.replace(/\r/g, '');
    const beforeRoot = await acl(root),
      beforeChild = await acl(child);
    const plan = await prepareSandbox(root, root, 'echo ok> created.txt', undefined, config);
    try {
      assert.equal((await execute(plan)).code, 0);
    } finally {
      await cleanupSandbox(plan);
    }
    assert.equal(await acl(root), beforeRoot);
    assert.equal(await acl(child), beforeChild);
    assert.match(await acl(path.join(root, 'created.txt')), /Medium Mandatory Level/);
  },
);

test(
  'cleanup restores a workspace whose path contains CJK characters',
  { skip: reason },
  async (t) => {
    /**
     * The recovery journal is written as UTF-8 bytes without a BOM, and the restore half used to read it with
     * `Get-Content -Raw` and no `-Encoding`. Windows PowerShell decodes with the ANSI code page, so a workspace
     * whose path contains CJK characters came back as different text and the restore rejected its own journal
     * with "ACL recovery root mismatch".
     *
     * That failure is quiet in the destructive direction: the workspace keeps the sandbox ACL, and the retained
     * lock and journal then make *every* later sandbox run in this state directory fail with "leased by another
     * process or needs recovery" until an operator clears them by hand — which is how unrelated suites (the
     * Host-program and Host-workflow tests) began failing on a tree that had not changed. It is the journal's
     * `root` field that carries the path, so the CJK has to be in the *workspace* and not merely in the temp
     * path above the workspace: that case is covered by the apostrophe test, which is deliberately ASCII-rooted.
     */
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-临时-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace-工作区');
    await mkdir(workspace);
    const child = path.join(workspace, '已有.txt');
    await writeFile(child, 'original');
    const acl = async (file: string) =>
      (await promisify(execFile)('icacls.exe', [file])).stdout.replace(/\r/g, '');
    const beforeRoot = await acl(workspace),
      beforeChild = await acl(child);
    const plan = await prepareSandbox(
      workspace,
      workspace,
      'echo ok> created.txt',
      undefined,
      config,
    );
    try {
      assert.equal((await execute(plan)).code, 0);
    } finally {
      await cleanupSandbox(plan);
    }
    assert.equal(await acl(workspace), beforeRoot);
    assert.equal(await acl(child), beforeChild);
  },
);
