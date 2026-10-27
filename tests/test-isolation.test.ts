import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIsolation } from '../scripts/test-isolation/environment.mjs';
import { settleProcesses } from '../scripts/test-isolation/processes.mjs';

for (const transient of [true, false])
  test(
    `Windows deleted-object paths retry without allowing unknown targets (transient: ${transient})`,
    { skip: process.platform !== 'win32' && 'NTFS deleted-object names are Windows-only' },
    async (t) => {
      const parent = await fixture(t);
      const isolation = await createIsolation(parent, 'deleted-path.test.ts', [], process.env);
      const result = run(
        isolation,
        `
      import fs from 'node:fs';
      import path from 'node:path';
      const target = path.join(process.env.TEMP, 'maintenance-lock');
      fs.writeFileSync(target, 'owned');
      const native = fs.realpathSync.native;
      let calls = 0;
      fs.realpathSync.native = (file) => file === target && (++calls <= ${transient ? 2 : 100})
        ? path.parse(target).root + '$Extend\\\\$Deleted\\\\synthetic-object'
        : native(file);
      const { resolvedTarget, inside } = await import('./scripts/test-isolation/paths.mjs?deleted=${transient}');
      try {
        console.log(JSON.stringify({ inside: inside(process.env.FOUNDRY_TEST_ROOT, resolvedTarget(target)), calls }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, calls }));
      }
    `,
      );
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      if (transient) assert.deepEqual(observed, { inside: true, calls: 3 });
      else assert.deepEqual(observed, { code: 'EAGAIN', calls: 3 });
    },
  );

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-isolation-tests-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
function run(isolation: Awaited<ReturnType<typeof createIsolation>>, code: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: isolation.env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('isolated Host fixtures use host without inheriting operator sandbox or permission settings', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'host.test.ts', [], {
    ...process.env,
    YUANTU_SANDBOX: 'host',
    YUANTU_PERMISSION_POLICY: 'operator-policy.json',
  });
  const result = run(
    isolation,
    `
    import { applySandboxDefaults } from ${JSON.stringify(new URL('../apps/shared/runtime.ts', import.meta.url).href)};
    applySandboxDefaults(); console.log(process.env.YUANTU_SANDBOX);
  `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'host');
  assert.equal(isolation.env.YUANTU_PERMISSION_POLICY, undefined);
});

test('SQLite owned filenames preserve quoted comment markers, semicolons and escaped quotes', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'quoted-sql.test.ts', [], process.env);
  const result = run(
    isolation,
    `
    import {DatabaseSync} from 'node:sqlite'; import path from 'node:path';
    const db=new DatabaseSync(':memory:');
    for(const name of ['backup--copy.sqlite','semi;colon.sqlite',"quote'--copy.sqlite"]){
      const target=path.join(process.env.TMP,name).replaceAll("'","''");
      db.exec("/* before */ VACUUM /* between */ INTO '"+target+"'; -- after");
    }
    db.prepare('VACUUM INTO ?').run(path.join(process.env.TMP,'bound--copy.sqlite'));
    db.close();console.log('owned backups created');
  `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owned backups created/);
});

test('each file receives distinct temporary and state directories without inheriting credentials', async (t) => {
  const parent = await fixture(t);
  const a = await createIsolation(parent, 'a.test.ts', [], {
    ...process.env,
    YUANTU_API_KEY: 'must-not-inherit',
    OPENAI_API_KEY: 'must-not-inherit',
    FOUNDRY_TEST_GENERATE_SNAPSHOTS: '1',
  });
  const b = await createIsolation(parent, 'b.test.ts', [], process.env);
  assert.notEqual(a.root, b.root);
  assert.notEqual(a.env.TMP, b.env.TMP);
  assert.equal(a.env.YUANTU_API_KEY, undefined);
  assert.equal(a.env.OPENAI_API_KEY, undefined);
  // The one variable that would turn a snapshot comparison into a recording: an exported value here makes the
  // whole snapshot gate pass unconditionally, so a worker must never inherit it.
  assert.equal(a.env.FOUNDRY_TEST_GENERATE_SNAPSHOTS, undefined);
  for (const isolation of [a, b]) {
    const result = run(
      isolation,
      `import {writeFileSync} from 'node:fs'; import {tmpdir} from 'node:os';import path from 'node:path';writeFileSync(path.join(tmpdir(),'same.txt'),'owned');console.log(JSON.stringify({tmp:tmpdir(),state:process.env.YUANTU_STATE_DIR}));`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).tmp, isolation.env.TMP);
    assert.equal(await readFile(path.join(isolation.env.TMP!, 'same.txt'), 'utf8'), 'owned');
  }
});

test('sync, promises, handles and SQLite cannot write into a sibling file root, even when caught', async (t) => {
  const parent = await fixture(t);
  const a = await createIsolation(parent, 'a.test.ts', [], process.env);
  const b = await createIsolation(parent, 'b.test.ts', [], process.env);
  const cases = [
    `import{writeFileSync}from'node:fs';writeFileSync(target,'bad')`,
    `import{writeFile}from'node:fs/promises';await writeFile(target,'bad')`,
    `import{open}from'node:fs/promises';const handle=await open(target,'w');await handle.writeFile('bad');await handle.close()`,
    `import{DatabaseSync}from'node:sqlite';new DatabaseSync(target)`,
  ];
  for (let index = 0; index < cases.length; index++) {
    const code = cases[index]!;
    const imports = code.slice(0, code.indexOf(';') + 1);
    const body = code.slice(imports.length);
    const result = run(
      a,
      `${imports}const target=${JSON.stringify(path.join(b.root, 'outside-' + index))};try{${body}}catch{}process.exit(0);`,
    );
    assert.equal(result.status, 1, result.stderr);
  }
  assert.match(await readFile(a.violationPath, 'utf8'), /outside|ownership/);
});

test('chdir and fixed listener ports are refused while loopback dynamic ports work', async (t) => {
  const parent = await fixture(t);
  for (const code of [
    'try{process.chdir(process.env.TMP)}catch{}',
    "import{createServer}from'node:net';try{createServer().listen(32454,'127.0.0.1')}catch{}",
  ]) {
    const isolation = await createIsolation(parent, 'bad.test.ts', [], process.env);
    const result = run(isolation, code);
    assert.equal(result.status, 1, result.stderr);
  }
  const isolation = await createIsolation(parent, 'network.test.ts', [], process.env);
  const result = run(
    isolation,
    "import{createServer}from'node:net';const a=createServer(),b=createServer();await Promise.all([a,b].map(s=>new Promise(r=>s.listen(0,'127.0.0.1',r))));console.log(a.address().port!==b.address().port);await Promise.all([a,b].map(s=>new Promise(r=>s.close(r))));",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /true/);
});

test(
  'native PTY declaration does not grant arbitrary Windows named pipes',
  {
    skip: process.platform !== 'win32' && 'needs Windows',
  },
  async (t) => {
    const parent = await fixture(t);
    for (const [resources, pipe] of [
      [[], String.raw`\\.\pipe\conpty-123.456-out-worker`],
      [['real-pty'], String.raw`\\.\pipe\foreign-test-pipe`],
    ] as const) {
      const isolation = await createIsolation(
        parent,
        'pipe-owner.test.ts',
        [...resources],
        process.env,
      );
      const result = run(
        isolation,
        `import {createServer} from 'node:net';try{createServer().listen(${JSON.stringify(pipe)})}catch{}`,
      );
      assert.equal(result.status, 1, result.stderr);
      const violation = JSON.parse((await readFile(isolation.violationPath, 'utf8')).trim());
      assert.equal(violation.rule, 'ownership');
    }
  },
);

test('a junction cannot redirect an owned write into another file root', async (t) => {
  const parent = await fixture(t);
  const a = await createIsolation(parent, 'a.test.ts', [], process.env);
  const b = await createIsolation(parent, 'b.test.ts', [], process.env);
  const result = run(
    a,
    `import{symlinkSync,writeFileSync}from'node:fs';import path from'node:path';const link=path.join(process.env.TMP,'link');symlinkSync(${JSON.stringify(b.root)},link,'junction');try{writeFileSync(path.join(link,'bad'),'bad')}catch{}`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(await readFile(a.violationPath, 'utf8'), /ownership/);
});

test('a dangling symlink cannot launder an owned write outside the worker root', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'dangling-link.test.ts', [], process.env);
  const outside = path.join(parent, 'outside-dangling.txt');
  const link = path.join(isolation.env.TMP!, 'dangling-link.txt');
  try {
    symlinkSync(outside, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('symlink creation needs privileges on this host');
    throw error;
  }
  // The link's lexical parent is inside the root while its target is outside; a resolver that walks up and
  // appends the name would allow this write and create the outside file.
  const result = run(
    isolation,
    `import{writeFileSync}from'node:fs';try{writeFileSync(${JSON.stringify(link)},'escaped')}catch{}`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(await readFile(isolation.violationPath, 'utf8'), /ownership/);
  assert.equal(existsSync(outside), false);
});

test('a dangling symlink inside the worker root can still be removed', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'delete-dangling.test.ts', [], process.env);
  const neverCreated = path.join(parent, 'never-created.txt');
  const link = path.join(isolation.env.TMP!, 'delete-dangling.txt');
  try {
    symlinkSync(neverCreated, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('symlink creation needs privileges on this host');
    throw error;
  }
  // Deleting the entry is not writing through it, so an unresolvable target must not make cleanup impossible.
  const result = run(
    isolation,
    `import{unlinkSync}from'node:fs';unlinkSync(${JSON.stringify(link)});console.log('removed')`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed/);
  assert.equal(existsSync(link), false);
});

test('missing listener hosts never permit wildcard TCP or UDP binds', async (t) => {
  const parent = await fixture(t);
  for (const code of [
    "import{createServer}from'node:net';try{createServer().listen(0)}catch{}",
    "import{createSocket}from'node:dgram';const s=createSocket('udp4');try{s.bind({port:0})}catch{}s.close()",
    "import{createServer}from'node:net';try{createServer().listen({port:0,host:'0.0.0.0'})}catch{}",
  ]) {
    const isolation = await createIsolation(parent, 'wildcard.test.ts', [], process.env);
    assert.equal(run(isolation, code).status, 1);
    assert.match(await readFile(isolation.violationPath, 'utf8'), /listeners must use loopback/);
  }
});

test('callback descriptors and handles cannot mutate a read-only outside file', async (t) => {
  const parent = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  const outside = path.join(parent, 'existing.txt');
  await writeFile(outside, 'original');
  for (const code of [
    `import fs from'node:fs';fs.open(target,'r',(error,fd)=>{try{fs.fchmodSync(fd,0o600)}catch{}fs.closeSync(fd)})`,
    `import{open}from'node:fs/promises';const h=await open(target,'r');try{await h.chmod(0o600)}catch{}await h.close()`,
    `import fs from'node:fs';try{fs.writeFile(target,'bad',()=>{})}catch{}`,
  ]) {
    const isolation = await createIsolation(parent, 'handles.test.ts', [], process.env);
    const split = code.indexOf(';') + 1;
    const result = run(
      isolation,
      `${code.slice(0, split)}const target=${JSON.stringify(outside)};${code.slice(split)}`,
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(await readFile(isolation.violationPath, 'utf8'), /ownership/);
  }
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('child cwd is validated and an explicitly filtered guest environment stays filtered', async (t) => {
  const parent = await fixture(t);
  const bad = await createIsolation(parent, 'cwd.test.ts', [], process.env);
  assert.equal(
    run(
      bad,
      `import{spawnSync}from'node:child_process';try{spawnSync(process.execPath,['-e',''],{cwd:${JSON.stringify(parent)}})}catch{}`,
    ).status,
    1,
  );
  const good = await createIsolation(parent, 'guest.test.ts', [], process.env);
  const result = run(
    good,
    `import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(process.env))'],{cwd:process.env.TMP,env:{SYNTHETIC:'fixture'},encoding:'utf8'});console.log(r.stdout)`,
  );
  assert.equal(result.status, 0, result.stderr);
  const guest = JSON.parse(result.stdout);
  assert.equal(guest.SYNTHETIC, 'fixture');
  assert.equal(guest.FOUNDRY_TEST_ISOLATION, undefined);
  assert.equal(guest.NODE_OPTIONS, undefined);
});

test('promisified subprocess calls retain stdout, stderr and owned process registration', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'promisify.test.ts', [], process.env);
  const result = run(
    isolation,
    `import{execFile}from'node:child_process';import{promisify}from'node:util';const promise=promisify(execFile)(process.execPath,['-e',"process.stdout.write('output');process.stderr.write('diagnostic')"]);if(!promise.child)throw Error('child missing');console.log(JSON.stringify(await promise))`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { stdout: 'output', stderr: 'diagnostic' });
  assert.match(await readFile(isolation.processPath, 'utf8'), /"event":"spawn"/);
});

test('nested negative fixtures have separate authoritative violation records', async (t) => {
  const parent = await fixture(t);
  const outer = await createIsolation(parent, 'outer.test.ts', [], process.env);
  const module = new URL('../scripts/test-isolation/environment.mjs', import.meta.url).href;
  const result = run(
    outer,
    `import{createIsolation}from${JSON.stringify(module)};import{spawnSync}from'node:child_process';import path from'node:path';const child=await createIsolation(path.join(process.env.TMP,'nested'),'negative',[],process.env);const r=spawnSync(process.execPath,['-e','try{process.chdir(process.env.TMP)}catch{}'],{env:child.env,encoding:'utf8'});if(r.status!==1)throw Error(r.stderr);console.log('isolated negative child');`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolated negative child/);
});

test('SQLite backup and commented file-producing statements cannot escape', async (t) => {
  const parent = await fixture(t);
  for (const [action, rule] of [
    [`try{await backup(db,target)}catch{}`, 'ownership'],
    [`try{db.exec('/* comment */ VACUUM INTO '+JSON.stringify(target))}catch{}`, 'ownership'],
    [
      `try{db.prepare('-- comment\\nATTACH DATABASE ? AS attached').run(target)}catch{}`,
      'ownership',
    ],
    [`try{db.prepare('ATTACH DATABASE (?) AS attached').run(target)}catch{}`, 'sqlite'],
    [`try{db.prepare("VACUUM INTO (? || '')").run(target)}catch{}`, 'sqlite'],
  ]) {
    const isolation = await createIsolation(parent, 'sqlite-target.test.ts', [], process.env);
    const result = run(
      isolation,
      `import{DatabaseSync,backup}from'node:sqlite';const target=${JSON.stringify(path.join(parent, 'outside.db'))};const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t(n)');${action}db.close()`,
    );
    assert.equal(result.status, 1, result.stderr);
    const violation = JSON.parse((await readFile(isolation.violationPath, 'utf8')).trim());
    assert.equal(violation.rule, rule);
  }
});

test('every spelling that sets a SQLite store directory outside the root is refused', async (t) => {
  const parent = await fixture(t);
  // The pragma that points SQLite at a directory produces files there, exactly like `VACUUM INTO`; only the
  // `name = 'path'` spelling used to be read, so the function-call form and a quoted pragma name slipped past.
  for (const statement of [
    `"PRAGMA temp_store_directory='" + target + "'"`,
    `'PRAGMA temp_store_directory(' + JSON.stringify(target) + ')'`,
    `'PRAGMA "temp_store_directory" = ' + JSON.stringify(target)`,
    `"PRAGMA data_store_directory='" + target + "'"`,
  ]) {
    const isolation = await createIsolation(parent, 'pragma-target.test.ts', [], process.env);
    const result = run(
      isolation,
      `import{DatabaseSync}from'node:sqlite';const target=${JSON.stringify(path.join(parent, 'outside-store'))};const db=new DatabaseSync(':memory:');try{db.exec(${statement})}catch{}db.close()`,
    );
    assert.equal(result.status, 1, `${statement}: ${result.stderr}`);
    const violation = JSON.parse((await readFile(isolation.violationPath, 'utf8')).trim());
    assert.equal(violation.rule, 'ownership');
  }
});

test(
  'Windows settlement does not mistake a reused PID for its exited owner',
  { skip: process.platform !== 'win32' && 'needs Windows process creation identity' },
  async (t) => {
    const parent = await fixture(t);
    const isolation = await createIsolation(parent, 'reused-pid.test.ts', [], process.env);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      env: { SystemRoot: process.env.SystemRoot },
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    assert.ok(child.pid);
    // The ledger belongs to an earlier process with this PID. The live child was created
    // long after its ownership window, as when Windows reuses a force-killed fixture's PID.
    await writeFile(
      isolation.processPath,
      JSON.stringify({ event: 'owner-start', pid: child.pid, started: 1, at: 2 }) + '\n',
    );
    const settled = await settleProcesses(isolation, {
      terminate: (pid) => {
        process.kill(pid, 'SIGKILL');
      },
    });
    assert.equal(settled.clean, true);
    assert.deepEqual(settled.remaining, []);
    assert.deepEqual(settled.verified, []);
    assert.deepEqual(settled.terminated, []);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  },
);

test('settlement retains an active PID when its ownership cannot be proved', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'unverified-pid.test.ts', [], process.env);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { SystemRoot: process.env.SystemRoot },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  assert.ok(child.pid);
  await writeFile(
    isolation.processPath,
    JSON.stringify({ event: 'owner-start', pid: child.pid, at: Date.now() }) + '\n',
  );
  const settled = await settleProcesses(isolation, {
    terminate: (pid) => {
      process.kill(pid, 'SIGKILL');
    },
    timeoutMs: 0,
  });
  assert.equal(settled.clean, false);
  assert.deepEqual(settled.remaining, [child.pid]);
  assert.deepEqual(settled.verified, []);
  assert.deepEqual(settled.terminated, []);
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
});

test(
  'Windows settlement fails closed when the process identity query fails',
  { skip: process.platform !== 'win32' && 'needs Windows process creation identity' },
  async (t) => {
    const parent = await fixture(t);
    const module = new URL('../scripts/test-isolation/processes.mjs?failed-proof', import.meta.url)
      .href;
    for (const proof of [
      { status: 1, stdout: '2026-01-01T00:00:00.000Z' },
      { status: null, stdout: '', error: { code: 'ETIMEDOUT' } },
      { status: 0, stdout: 'invalid creation time' },
    ]) {
      const isolation = await createIsolation(parent, 'failed-proof.test.ts', [], process.env);
      const result = run(
        isolation,
        `
        import childProcess from 'node:child_process';
        import fs from 'node:fs';
        // Only the external identity query is replaced; the real settlement checks
        // a live process against a stale registration and must retain uncertainty.
        childProcess.spawnSync = () => (${JSON.stringify(proof)});
        const { settleProcesses } = await import(${JSON.stringify(module)});
        const processPath = process.env.TMP + '/failed-proof.ndjson';
        fs.writeFileSync(processPath, JSON.stringify({event:'owner-start',pid:process.pid,started:1,at:2})+'\\n');
        const settled = await settleProcesses({processPath}, {
          terminate: () => { throw Error('termination without identity proof'); },
          timeoutMs: 0,
        });
        console.log(JSON.stringify({clean:settled.clean,remaining:settled.remaining,verified:settled.verified,terminated:settled.terminated,pid:process.pid}));
      `,
      );
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.deepEqual(observed, {
        clean: false,
        remaining: [observed.pid],
        verified: [],
        terminated: [],
        pid: observed.pid,
      });
    }
  },
);

test('settlement detects and cleans an identity-verified abandoned descendant without passing it', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'abandoned.test.ts', [], process.env);
  const result = run(
    isolation,
    `import{spawn}from'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{SystemRoot:process.env.SystemRoot},stdio:'ignore',windowsHide:true,detached:true});c.unref();console.log(c.pid)`,
  );
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  t.after(() =>
    settleProcesses(isolation, {
      terminate: async (owned: number) => {
        try {
          process.kill(owned, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
    }),
  );
  const settled = await settleProcesses(isolation, {
    terminate: async (owned: number) => {
      process.kill(owned, 'SIGKILL');
    },
  });
  assert.equal(settled.clean, false);
  assert.deepEqual(settled.verified, [pid]);
  assert.deepEqual(settled.remaining, []);
});

test('self-registration catches a grandchild whose uninstrumented parent has already exited', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'grandchild.test.ts', [], process.env);
  t.after(() =>
    settleProcesses(isolation, {
      terminate: async (pid: number) => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
    }),
  );
  const result = run(
    isolation,
    `import{spawnSync}from'node:child_process';import path from'node:path';const ready=path.join(process.env.TMP,'ready');const guest="require('node:fs').writeFileSync("+JSON.stringify(ready)+",'ready');setInterval(()=>{},1000)";const launcher="const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(guest)+"],{env:"+JSON.stringify(process.env)+",stdio:'ignore',detached:true});c.unref();const until=Date.now()+10000;while(!fs.existsSync("+JSON.stringify(ready)+")){if(Date.now()>until)throw Error('registration timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}console.log(c.pid)";const r=spawnSync(process.execPath,['-e',launcher],{env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});if(r.status)throw Error(r.stderr);console.log(r.stdout.trim())`,
  );
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  const settled = await settleProcesses(isolation, {
    terminate: async (owned: number) => {
      process.kill(owned, 'SIGKILL');
    },
  });
  assert.equal(settled.clean, false);
  assert.deepEqual(settled.verified, [pid]);
  assert.deepEqual(settled.remaining, []);
  assert.ok(settled.records.some((entry) => entry.event === 'owner-start' && entry.pid === pid));
});

test('native PTY entry refuses a missing resource tag before loading a native backend', async (t) => {
  const parent = await fixture(t);
  const isolation = await createIsolation(parent, 'missing-native-tag.test.ts', [], process.env);
  const module = new URL('../packages/tools/pty-provider.ts', import.meta.url).href;
  const result = run(
    isolation,
    `import{nodePtyProvider}from${JSON.stringify(module)};try{await nodePtyProvider.spawn({file:process.execPath,args:['-e',''],cwd:process.env.TMP,env:process.env,columns:80,rows:24})}catch{}`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    await readFile(isolation.violationPath, 'utf8'),
    /native operation requires @test-serial real-pty/,
  );
});

test('SQLite WAL and backup files remain owned and an outside VACUUM target is refused', async (t) => {
  const parent = await fixture(t);
  const a = await createIsolation(parent, 'sqlite.test.ts', [], process.env);
  const outside = path.join(parent, 'outside.sqlite');
  const result = run(
    a,
    `import{DatabaseSync}from'node:sqlite';import path from'node:path';const db=new DatabaseSync(path.join(process.env.TMP,'own.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE t(n)');try{db.prepare('VACUUM INTO ?').run(${JSON.stringify(outside)})}catch{}db.close();console.log('owned SQLite completed');`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /owned SQLite completed/, result.stderr);
  assert.match(await readFile(a.violationPath, 'utf8'), /ownership/);
});

test('normal Node descendants inherit private paths and a swallowed child violation fails its owner', async (t) => {
  const parent = await fixture(t);
  const a = await createIsolation(parent, 'parent.test.ts', [], process.env);
  const outside = path.join(parent, 'outside.txt');
  const result = run(
    a,
    `import{spawnSync}from'node:child_process';const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(`import{writeFileSync}from'node:fs';try{writeFileSync(${JSON.stringify(outside)},'bad')}catch{}process.exit(0)`)}],{encoding:'utf8'});console.log(JSON.stringify({child:child.status}));process.exit(0);`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).child, 1);
  assert.match(await readFile(a.processPath, 'utf8'), /"event":"spawn"/);
});
