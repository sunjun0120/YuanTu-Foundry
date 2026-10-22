import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  seatbeltQuote,
  seatbeltProfile,
  seatbeltEnvironment,
  resolveSeatbeltPaths,
  inspectSeatbeltWorkspace,
  seatbeltSandboxProvider,
} from '../packages/tools/sandbox-seatbelt.ts';
import type { SandboxPlan } from '../packages/tools/sandbox-provider.ts';
import { markSandboxStarted, stopSandbox } from '../packages/tools/sandbox.ts';

test('Seatbelt quoting keeps policy syntax inside the path string and refuses controls', () => {
  assert.equal(seatbeltQuote('/tmp/a"\\b'), '"/tmp/a\\"\\\\b"');
  for (const invalid of ['/tmp/a\0b', '/tmp/a\nb', '/tmp/a\rb'])
    assert.throws(() => seatbeltQuote(invalid), /control/i);
});

test('profile separates workspace write effects from private scratch and networking', () => {
  const base = {
    root: '/work/project',
    scratch: '/private/tmp/call',
    runtimePaths: ['/runtime/node'],
  };
  const readonly = seatbeltProfile({ ...base, files: 'read-only', network: 'denied' });
  assert.match(readonly, /\(deny default\)/);
  assert.doesNotMatch(readonly, /\(allow file-read\*\)/);
  // macOS 26 startup needs the root listing; that must stay a literal, never a subtree grant.
  assert.match(readonly, /\(allow file-read-data \(literal "\/"\)\)/);
  assert.doesNotMatch(readonly, /\(subpath "\/"\)/);
  assert.doesNotMatch(readonly, /\(allow network\*/);
  assert.doesNotMatch(readonly, /\(allow file-write\* \(subpath "\/work\/project"\)/);
  assert.match(readonly, /\(allow file-write\* \(require-all \(subpath "\/private\/tmp\/call"\)/);
  assert.doesNotMatch(readonly, /\(subpath "\/private\/tmp"\)/);
  // /System/Volumes/Data includes user homes: /System itself must never be a read subtree.
  assert.doesNotMatch(readonly, /\(subpath "\/System"\)/);
  assert.match(readonly, /\(subpath "\/Library\/Developer\/CommandLineTools\/usr"\)/);
  assert.match(readonly, /\(subpath "\/Applications\/Xcode\.app\/Contents\/Developer\/usr"\)/);
  assert.doesNotMatch(readonly, /\(subpath "\/Library"\)/);
  const writable = seatbeltProfile({ ...base, files: 'workspace-write', network: 'unrestricted' });
  assert.match(writable, /\(allow network\*\)/);
  assert.match(writable, /require-not/);
  for (const name of ['git', 'yuantu', 'agents', 'codex']) assert.ok(writable.includes(name));
  assert.throws(
    () => seatbeltProfile({ ...base, root: '/', files: 'read-only', network: 'denied' }),
    /workspace root/i,
  );
  assert.throws(
    () =>
      seatbeltProfile({
        ...base,
        root: '/private/tmp',
        files: 'workspace-write',
        network: 'denied',
      }),
    /workspace root/i,
  );
});

test('workspace inspection refuses preexisting shared-inode aliases and resolves metadata aliases', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-links-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'nested'));
  await mkdir(path.join(fixture, 'target'));
  await symlink(
    path.join(fixture, 'target'),
    path.join(fixture, 'nested', '.codex'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const protectedPaths = await inspectSeatbeltWorkspace(fixture);
  assert.ok(protectedPaths.some((p) => p.endsWith(path.sep + 'target')));
  await writeFile(path.join(fixture, 'original'), 'secret');
  await link(path.join(fixture, 'original'), path.join(fixture, 'alias'));
  await assert.rejects(inspectSeatbeltWorkspace(fixture), /hardlinks/);
});

test('profile protects internal directory components with mixed casing on macOS volumes', () => {
  const profile = seatbeltProfile({
    root: '/work/project',
    scratch: '/private/tmp/call',
    runtimePaths: [],
    files: 'workspace-write',
    network: 'denied',
  });
  const patterns = [...profile.matchAll(/\(regex #"([^"]+)"\)/g)].map(
    (match) => new RegExp(match[1]!),
  );
  assert.equal(patterns.length, 2);
  for (const pattern of patterns) {
    for (const name of ['.GiT', '.YuanTu', '.AgEnTs', '.CoDeX', '.AWS', '.SSH', '.GnuPG']) {
      assert.ok(pattern.test('/work/project/nested/' + name + '/config'), name);
      assert.ok(pattern.test('/private/tmp/call/' + name), name);
    }
    assert.equal(pattern.test('/work/project/.github/workflows'), false);
    assert.equal(pattern.test('/work/project/ordinary'), false);
  }
});

test('guest environment drops ambient credentials and loader hooks and pins scratch overrides', () => {
  const env = seatbeltEnvironment(
    '/scratch',
    {
      PATH: '/bin',
      HOME: '/secret-home',
      OPENAI_API_KEY: 'secret',
      NODE_OPTIONS: '--require /evil',
      DYLD_INSERT_LIBRARIES: '/evil',
      DYLD_LIBRARY_PATH: '/evil',
      LD_LIBRARY_PATH: '/evil',
    },
    { FIXTURE_VALUE: 'trusted', TMPDIR: '/outside' },
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.FIXTURE_VALUE, 'trusted');
  assert.equal(env.TMPDIR, '/scratch');
  assert.equal(env.HOME, '/scratch');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DYLD_LIBRARY_PATH, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
});

test('canonical cwd rejects symlink escapes and ordinary outside paths', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-paths-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'root');
  const outside = path.join(fixture, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await assert.rejects(resolveSeatbeltPaths(root, outside), /outside workspace/);
  await symlink(
    outside,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(resolveSeatbeltPaths(root, path.join(root, 'link')), /outside workspace/);
});

test('cleanup refuses to remove a forged directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seatbeltSandboxProvider.cleanup({ cleanupPath: directory } as SandboxPlan);
  assert.ok((await stat(directory)).isDirectory());
});

test(
  'Seatbelt fails closed on non-macOS instead of returning a host plan',
  { skip: process.platform === 'darwin' ? 'this asserts the non-macOS failure path' : false },
  async () => {
    assert.match((await seatbeltSandboxProvider.available())!, /macOS/);
    await assert.rejects(
      seatbeltSandboxProvider.prepare({
        root: process.cwd(),
        cwd: process.cwd(),
        command: 'true',
        config: { mode: 'seatbelt', image: '' },
      }),
      /macOS/,
    );
  },
);

function execute(plan: SandboxPlan): Promise<{ code: number | null; out: string; error: string }> {
  return new Promise((resolve, reject) => {
    markSandboxStarted(plan);
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let error = '';
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, 15000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      error += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      void stopSandbox(child, plan).then(() => resolve({ code, out, error }), reject);
    });
  });
}

test(
  'macOS kernel confines subprocess reads, writes, protected metadata and private scratch',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: seatbelt confinement is a macOS facility'
        : false,
  },
  async (t) => {
    assert.equal(await seatbeltSandboxProvider.available(), null);
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-kernel-'));
    const root = path.join(fixture, 'root');
    await mkdir(root);
    const outside = path.join(fixture, 'outside');
    await writeFile(outside, 'original');
    const plans: SandboxPlan[] = [];
    t.after(async () => {
      for (const plan of plans) {
        await seatbeltSandboxProvider.cleanup(plan);
        // These fixture scripts only use waited spawnSync descendants. The test
        // has observed their closure and can remove its own retained artifacts.
        await rm(plan.cleanupPath!, { recursive: true, force: true });
      }
      await rm(fixture, { recursive: true, force: true });
    });
    const first = await seatbeltSandboxProvider.prepare({
      root,
      cwd: root,
      command: process.execPath,
      argv: ['-e', 'require("fs").writeFileSync(process.env.TMPDIR+"/own","ok")'],
      config: { mode: 'seatbelt', image: '' },
    });
    plans.push(first);
    assert.equal(first.executable, '/usr/bin/sandbox-exec');
    assert.equal(first.processTree, 'process-group');
    await assert.rejects(
      seatbeltSandboxProvider.prepare({
        root,
        cwd: root,
        command: '-p',
        argv: ['(allow default)'],
        config: { mode: 'seatbelt', image: '' },
      }),
      /begin with an option/,
    );
    assert.equal((await execute(first)).code, 0);
    assert.equal(await readFile(path.join(first.cleanupPath!, 'own'), 'utf8'), 'ok');
    await seatbeltSandboxProvider.cleanup({ ...first });
    assert.equal(await readFile(path.join(first.cleanupPath!, 'own'), 'utf8'), 'ok');
    for (const action of [
      `require('fs').readFileSync(${JSON.stringify(outside)})`,
      `require('fs').unlinkSync(${JSON.stringify(outside)})`,
      `require('fs').writeFileSync(${JSON.stringify(path.join(first.cleanupPath!, 'foreign'))}, 'escape')`,
      `require('fs').mkdirSync('.codex')`,
      `require('fs').mkdirSync('.CoDeX')`,
      `require('fs').renameSync(${JSON.stringify(root)}, ${JSON.stringify(root + '-moved')})`,
      `require('fs').rmdirSync(${JSON.stringify(root)})`,
    ]) {
      const plan = await seatbeltSandboxProvider.prepare({
        root,
        cwd: root,
        command: process.execPath,
        argv: [
          '-e',
          `const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(action)}]);process.exit(r.status ?? 2)`,
        ],
        config: { mode: 'seatbelt', image: '' },
      });

      plans.push(plan);
      const result = await execute(plan);
      assert.notEqual(result.code, 0, result.error);
    }
    assert.equal(await readFile(outside, 'utf8'), 'original');
    assert.ok((await stat(root)).isDirectory());
    await assert.rejects(stat(path.join(first.cleanupPath!, 'foreign')), { code: 'ENOENT' });
    const readonly = await seatbeltSandboxProvider.prepare({
      root,
      cwd: root,
      command: process.execPath,
      argv: ['-e', 'require("fs").writeFileSync("refused","x")'],
      config: { mode: 'seatbelt', image: '', files: 'read-only' },
    });
    plans.push(readonly);
    assert.notEqual((await execute(readonly)).code, 0);
    await seatbeltSandboxProvider.cleanup(first);
    await seatbeltSandboxProvider.cleanup(first);
    assert.ok((await stat(first.cleanupPath!)).isDirectory());
  },
);

test(
  'macOS argv preserves quotes and cwd, and both network policies undergo functional verification',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: seatbelt confinement is a macOS facility'
        : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-quoted-'));
    const cwd = path.join(root, 'directory"with quote');
    await mkdir(cwd);
    const expected = ['', 'a b', '"quoted"', '\\backslash', '$(echo unsafe)', '(allow default)'];
    const plans: SandboxPlan[] = [];
    t.after(async () => {
      for (const plan of plans) {
        await seatbeltSandboxProvider.cleanup(plan);
        await rm(plan.cleanupPath!, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    });
    for (const network of ['denied', 'unrestricted'] as const) {
      const plan = await seatbeltSandboxProvider.prepare({
        root,
        cwd,
        command: process.execPath,
        argv: [
          '-e',
          'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))',
          '--',
          ...expected,
        ],
        config: { mode: 'seatbelt', image: '', files: 'read-only', network },
      });
      plans.push(plan);
      const result = await execute(plan);
      assert.equal(result.code, 0, result.error);
      const actual = JSON.parse(result.out);
      assert.equal(actual.cwd, plan.cwd);
      assert.deepEqual(actual.args, expected);
      assert.deepEqual(await readFile(path.join(plan.cleanupPath!, 'probe'), 'utf8'), 'allowed');
    }
  },
);

async function eventually<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 8000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`macOS lifecycle fixture did not become ready: ${String(lastError ?? '')}`);
}

test(
  'macOS unused original plan cleans scratch while starting a forged copy does not claim ownership',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: seatbelt confinement is a macOS facility'
        : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-unused-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plan = await seatbeltSandboxProvider.prepare({
      root,
      cwd: root,
      command: '/usr/bin/true',
      argv: [],
      config: { mode: 'seatbelt', image: '' },
    });
    markSandboxStarted({ ...plan });
    await seatbeltSandboxProvider.cleanup(plan);
    await assert.rejects(stat(plan.cleanupPath!), { code: 'ENOENT' });
  },
);

test(
  'macOS cancellation stops a live foreground group and retains unknown descendant scratch',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: seatbelt confinement is a macOS facility'
        : false,
    timeout: 20000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-cancel-'));
    const plan = await seatbeltSandboxProvider.prepare({
      root,
      cwd: root,
      command: process.execPath,
      argv: [
        '-e',
        'require("fs").writeFileSync(process.env.TMPDIR+"/ready",String(process.pid));setTimeout(()=>process.exit(0),7000);setInterval(()=>{},1000)',
      ],
      config: { mode: 'seatbelt', image: '' },
    });
    markSandboxStarted(plan);
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      stdio: 'ignore',
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    void closed.catch(() => {});
    // Register teardown before waiting for readiness, including failed startup.
    t.after(async () => {
      await stopSandbox(child, plan);
      await closed;
      await rm(plan.cleanupPath!, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    });
    const pid = await eventually(
      async () => Number(await readFile(path.join(plan.cleanupPath!, 'ready'), 'utf8')),
      (value) => value > 0,
    );
    await stopSandbox(child, plan);
    await closed;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok((await stat(plan.cleanupPath!)).isDirectory());
  },
);

test(
  'macOS detached descendants inherit confinement and keep scratch after their leader exits',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: seatbelt confinement is a macOS facility'
        : false,
    timeout: 25000,
  },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-detached-'));
    const root = path.join(fixture, 'root');
    await mkdir(root);
    const outside = path.join(fixture, 'outside');
    await writeFile(outside, 'unchanged');
    // This is intentionally a self-limiting test guest. The independent deadline
    // runs even if the parent fails before obtaining the detached PID.
    const detachedScript = `
const fs = require('node:fs');
const scratch = process.env.TMPDIR;
const deadline = setTimeout(() => process.exit(0), 5000);
let denied;
try { fs.writeFileSync(${JSON.stringify(outside)}, 'escape'); denied = false; }
catch (error) { denied = ['EACCES', 'EPERM'].includes(error.code); }
fs.writeFileSync(scratch + '/detached-ready', JSON.stringify({pid:process.pid, denied}));
let tick = 0;
const timer = setInterval(() => {
  try {
    fs.writeFileSync(scratch + '/heartbeat', String(++tick));
    if (fs.existsSync(scratch + '/stop')) {
      clearInterval(timer); clearTimeout(deadline);
      fs.writeFileSync(scratch + '/finished', 'stopped'); process.exit(0);
    }
  } catch { process.exit(2); }
}, 25);
`;
    const leaderScript = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(detachedScript)}],{detached:true,stdio:'ignore'});child.unref();`;
    const plan = await seatbeltSandboxProvider.prepare({
      root,
      cwd: root,
      command: process.execPath,
      argv: ['-e', leaderScript],
      config: { mode: 'seatbelt', image: '' },
    });
    let detachedPid: number | undefined;
    const startedAt = Date.now();
    t.after(async () => {
      // Ask the controlled guest to exit, then observe that it is no longer
      // alive. If readiness failed, its five-second lifetime still bounds it.
      await writeFile(path.join(plan.cleanupPath!, 'stop'), 'stop').catch(() => {});
      if (detachedPid) {
        await eventually(
          async () => {
            try {
              process.kill(detachedPid!, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
              throw error;
            }
          },
          (alive) => !alive,
        );
      } else {
        const remaining = 6500 - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      await seatbeltSandboxProvider.cleanup(plan);
      await rm(plan.cleanupPath!, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    });
    const result = await execute(plan);
    assert.equal(result.code, 0, result.error);
    const report = await eventually(
      async () =>
        JSON.parse(await readFile(path.join(plan.cleanupPath!, 'detached-ready'), 'utf8')),
      (value) => Number.isInteger(value.pid) && value.pid > 0,
    );
    detachedPid = report.pid;
    assert.equal(report.denied, true);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    await seatbeltSandboxProvider.cleanup({ ...plan });
    await seatbeltSandboxProvider.cleanup(plan);
    const first = await eventually(
      async () => Number(await readFile(path.join(plan.cleanupPath!, 'heartbeat'), 'utf8')),
      (value) => value > 0,
    );
    await eventually(
      async () => Number(await readFile(path.join(plan.cleanupPath!, 'heartbeat'), 'utf8')),
      (value) => value > first,
    );
    assert.ok((await stat(plan.cleanupPath!)).isDirectory());
  },
);
