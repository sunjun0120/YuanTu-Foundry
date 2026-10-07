import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTools } from '../packages/tools/index.ts';
import { toolEnvironment, workerExecArgv } from '../packages/tools/environment.ts';

const execFileAsync = promisify(execFile);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, tools: createTools(root) };
}
const ctx = () => ({ signal: new AbortController().signal, approve: async () => true });
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});

test('child environment is explicitly allowlisted and worker flags are sanitized', () => {
  const env = toolEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    FIXTURE_MARKER: '/tmp/marker',
    YUANTU_API_KEY: 'secret',
    RANDOM_HOST_SETTING: 'private',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.FIXTURE_MARKER, '/tmp/marker');
  assert.equal(env.YUANTU_API_KEY, undefined);
  assert.equal(env.RANDOM_HOST_SETTING, undefined);
  assert.deepEqual(
    workerExecArgv([
      '--trace-warnings',
      '--input-type=module',
      '--eval',
      'code',
      '--check',
      '--test-reporter',
      'spec',
      '--max-old-space-size=64',
    ]),
    ['--trace-warnings'],
  );
});

test('read, search, exact edit and create operate on real UTF-8 files', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'main.ts'), 'const greeting = "你好";\n');
  const read = await tools.execute(call('read_file', { path: 'main.ts' }), ctx());
  assert.match(read.content, /你好/);
  const search = await tools.execute(call('search_files', { query: 'greeting' }), ctx());
  assert.match(search.content, /main\.ts:1/);
  assert.equal(
    (
      await tools.execute(
        call('edit_file', { path: 'main.ts', old_text: '你好', new_text: '世界' }),
        ctx(),
      )
    ).isError,
    false,
  );
  assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const greeting = "世界";\n');
  await tools.execute(call('write_file', { path: 'new.txt', content: 'created' }), ctx());
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'created');
});

test('unknown top-level arguments explain the supported schema without executing the tool', async (t) => {
  const { tools } = await fixture(t);
  t.after(() => tools.close());
  const result = await tools.execute(call('repo_map', { path: 'fixture.ts' }), ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /additional properties/);
  assert.match(result.content, /Allowed top-level arguments: query, limit/);
});

test('schema validation and denied permission leave files unchanged', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'old');
  // Read first: the observation gate is an input check like schema validation, so an unread file would be refused
  // before the permission policy ever saw the call — and this test is about the denial.
  assert.equal((await tools.execute(call('read_file', { path: 'a.txt' }), ctx())).isError, false);
  const invalid = await tools.execute(
    call('edit_file', { path: 'a.txt', old_text: 2, new_text: 'new' }),
    ctx(),
  );
  assert.equal(invalid.isError, true);
  const denied = await tools.execute(
    call('edit_file', { path: 'a.txt', old_text: 'old', new_text: 'new' }),
    { ...ctx(), approve: async () => false },
  );
  assert.match(denied.content, /denied/i);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old');
});

test('traversal, internal files and ambiguous replacement are rejected', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'same same');
  for (const file of ['../secret.txt', '.env', '.git/config', '.yuantu/sessions.sqlite']) {
    assert.equal((await tools.execute(call('read_file', { path: file }), ctx())).isError, true);
  }
  assert.equal((await tools.execute(call('read_file', { path: 'a.txt' }), ctx())).isError, false);
  const ambiguous = await tools.execute(
    call('edit_file', { path: 'a.txt', old_text: 'same', new_text: 'new' }),
    ctx(),
  );
  assert.equal(ambiguous.isError, true);
  // The read is what makes this the *ambiguity* error rather than a refusal to touch an unread file.
  assert.match(ambiguous.content, /exactly once/i);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'same same');
});

test('directory links cannot escape workspace', async (t) => {
  const { root, tools } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(
    outside,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(
    (await tools.execute(call('read_file', { path: 'linked/secret.txt' }), ctx())).isError,
    true,
  );
  assert.equal(
    (await tools.execute(call('write_file', { path: 'linked/new.txt', content: 'bad' }), ctx()))
      .isError,
    true,
  );
});

test('apply_patch, delete, move and batch expose previews and mutate safely', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(root, 'b.txt'), 'red\n');
  const approvals: import('../packages/protocol/index.ts').FileChange[] = [];
  const context = {
    ...ctx(),
    approve: async (approval: import('../packages/protocol/index.ts').Approval) => {
      assert.ok(approval.change);
      approvals.push(approval.change);
      return true;
    },
  };
  // Both files are read first, as a model must: a patch and a batch both claim something about the current text.
  assert.equal((await tools.execute(call('read_file', { path: 'a.txt' }), context)).isError, false);
  assert.equal((await tools.execute(call('read_file', { path: 'b.txt' }), context)).isError, false);
  const patched = await tools.execute(
    call('apply_patch', {
      path: 'a.txt',
      patch: '@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
    }),
    context,
  );
  assert.equal(patched.isError, false, patched.content);
  const batch = await tools.execute(
    call('batch_edit', {
      edits: [
        { path: 'a.txt', old_text: 'three', new_text: 'four' },
        { path: 'b.txt', old_text: 'red', new_text: 'blue' },
      ],
    }),
    context,
  );
  assert.equal(batch.isError, false, batch.content);
  assert.equal(approvals.at(-1)?.changes?.length, 2);
  const moved = await tools.execute(call('move_file', { from: 'b.txt', to: 'c.txt' }), context);
  assert.equal(moved.isError, false, moved.content);
  assert.equal(approvals.at(-1)?.kind, 'move');
  const deleted = await tools.execute(call('delete_file', { path: 'c.txt' }), context);
  assert.equal(deleted.isError, false, deleted.content);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nfour\n');
  await assert.rejects(access(path.join(root, 'b.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'c.txt')), { code: 'ENOENT' });
});

test('mutation tools reject state changes made after approval preview', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'before');
  const result = await tools.execute(call('delete_file', { path: 'a.txt' }), {
    ...ctx(),
    approve: async () => {
      await writeFile(path.join(root, 'a.txt'), 'manual');
      return true;
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /changed since approval/i);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'manual');
});

test('foreground commands receive only the explicit environment allowlist', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(
    path.join(root, 'environment.cjs'),
    'console.log(JSON.stringify({path:!!process.env.PATH,fixture:process.env.FIXTURE_TRANSPORT,secret:process.env.UNLISTED_SECRET}))',
  );
  process.env.FIXTURE_TRANSPORT = 'kept';
  process.env.UNLISTED_SECRET = 'hidden';
  t.after(() => {
    delete process.env.FIXTURE_TRANSPORT;
    delete process.env.UNLISTED_SECRET;
  });
  const result = await tools.execute(
    call('run_command', { command: 'node environment.cjs' }),
    ctx(),
  );
  assert.equal(result.isError, false, result.content);
  assert.deepEqual(JSON.parse(JSON.parse(result.content).output.trim()), {
    path: true,
    fixture: 'kept',
  });
});

test('commands report actual exit status and require approval', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(
    path.join(root, 'exit.cjs'),
    'console.log("executed");console.error("stderr fixture");process.exit(7)',
  );
  const command = 'node exit.cjs';
  const denied = await tools.execute(call('run_command', { command }), {
    ...ctx(),
    approve: async () => false,
  });
  assert.equal(denied.isError, true);
  const result = await tools.execute(call('run_command', { command }), ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /executed/);
  assert.match(result.content, /exitCode.*7/);
  const value = JSON.parse(result.content);
  assert.equal(value.stdout, 'executed\n');
  assert.equal(value.stderr, 'stderr fixture\n');
  assert.equal(value.streamsTruncated, false);
});

test('cancellation kills a running command before its delayed side effect', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(
    path.join(root, 'wait.cjs'),
    'setTimeout(()=>require("fs").writeFileSync("late.txt","bad"),2000);setInterval(()=>{},1000)',
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    tools.execute(call('run_command', { command: 'node wait.cjs' }), {
      ...ctx(),
      signal: controller.signal,
    }),
    /abort|cancel/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await assert.rejects(readFile(path.join(root, 'late.txt')), { code: 'ENOENT' });
});

test('read/search outputs are bounded and search skips excluded directories', async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'needle');
  await writeFile(path.join(root, 'large.txt'), 'needle '.repeat(20_000));
  const result = await tools.execute(call('read_file', { path: 'large.txt' }), ctx());
  assert.ok(result.content.length < 40_000);
  const search = await tools.execute(call('search_files', { query: 'needle' }), ctx());
  assert.doesNotMatch(search.content, /hidden\.txt/);
  assert.ok(search.content.length < 40_000);
});

test('enhanced search supports regex, case modes, globs and result limits', async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'one.ts'), 'Alpha 123\nalpha 456\n');
  await writeFile(path.join(root, 'src', 'two.txt'), 'Alpha 789\n');
  const regex = await tools.execute(
    call('search_files', {
      query: '^alpha \\d+$',
      mode: 'regex',
      case: 'insensitive',
      include: ['**/*.ts'],
      max_results: 1,
    }),
    ctx(),
  );
  assert.match(regex.content, /src\/one\.ts:1/);
  assert.match(regex.content, /match limit reached/);
  const smart = await tools.execute(
    call('search_files', { query: 'alpha', case: 'smart', exclude: ['**/*.txt'] }),
    ctx(),
  );
  assert.match(smart.content, /one\.ts:1/);
  assert.doesNotMatch(smart.content, /two\.txt/);
  assert.equal(
    (await tools.execute(call('search_files', { query: '[', mode: 'regex' }), ctx())).isError,
    true,
  );
});

test('regex search ignores unsupported inherited worker execArgv', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'match.txt'), 'alpha 123\n');
  const original = process.execArgv;
  process.execArgv = [...original, '--input-type=module'];
  try {
    const result = await tools.execute(
      call('search_files', { query: '^alpha \\d+$', mode: 'regex' }),
      ctx(),
    );
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /match\.txt:1/);
  } finally {
    process.execArgv = original;
  }
});

test('pathological regex search is terminated without blocking the host', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(path.join(root, 'slow.txt'), 'a'.repeat(40_000) + '!\n');
  const started = Date.now();
  const result = await tools.execute(
    call('search_files', { query: '(a+)+$', mode: 'regex' }),
    ctx(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /timed out/i);
  assert.ok(Date.now() - started < 5000);
});

test('git tools require a contained repository and read status and diff', async (t) => {
  const { root, tools } = await fixture(t);
  await execFileAsync('git', ['init'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'],
    { cwd: root },
  );
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  const status = await tools.execute(call('git_status', {}), ctx());
  assert.equal(status.isError, false, status.content);
  assert.match(status.content, /tracked\.txt/);
  const diff = await tools.execute(
    call('git_diff', { mode: 'working', paths: ['tracked.txt'] }),
    ctx(),
  );
  assert.match(diff.content, /\+after/);
  assert.equal(
    (await tools.execute(call('git_diff', { paths: ['../outside'] }), ctx())).isError,
    true,
  );
});

test('validation discovery is bounded and execution shows resolved argv before approval', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "console.log(123)"', arbitrary: 'echo no' } }),
  );
  const discovered = await tools.execute(call('discover_validations', {}), ctx());
  assert.match(discovered.content, /npm:test/);
  assert.doesNotMatch(discovered.content, /arbitrary/);
  let approval = '';
  const denied = await tools.execute(call('run_validation', { id: 'npm:test' }), {
    ...ctx(),
    approve: async (request) => {
      approval = request.description;
      return false;
    },
  });
  assert.equal(denied.isError, true);
  assert.match(approval, /Resolved command:/);
  assert.match(approval, /npm run test/);
  assert.match(approval, /Manifest command: node -e/);
  assert.match(approval, /Manifest command: node -e/);
  const run = await tools.execute(call('run_validation', { id: 'npm:test' }), ctx());
  assert.equal(run.isError, false, run.content);
  assert.match(JSON.parse(run.content).output, /123/);
  assert.equal(
    (await tools.execute(call('run_validation', { id: 'npm:arbitrary' }), ctx())).isError,
    true,
  );
});
test(
  'Windows validation runs npm scripts through the native command interpreter',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, tools } = await fixture(t);
    t.after(() => tools.close());
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node fixture.cjs' } }),
    );
    await writeFile(
      path.join(root, 'fixture.cjs'),
      "require('node:fs').writeFileSync('verified.txt', 'actual execution'); console.log('VALIDATION_MARKER');",
    );
    const previous = process.env.YUANTU_SANDBOX;
    process.env.YUANTU_SANDBOX = 'windows';
    try {
      const result = await tools.execute(call('run_validation', { id: 'npm:test' }), ctx());
      assert.equal(result.isError, false, result.content);
      assert.match(JSON.parse(result.content).output, /VALIDATION_MARKER/);
      assert.equal(await readFile(path.join(root, 'verified.txt'), 'utf8'), 'actual execution');
    } finally {
      if (previous === undefined) delete process.env.YUANTU_SANDBOX;
      else process.env.YUANTU_SANDBOX = previous;
    }
  },
);

for (const testScript of ['node --test tests/*.test.mjs', 'node scripts/run-tests.mjs']) {
  test(`targeted validation reports failures and reruns only named failed tests (${testScript})`, async (t) => {
    const { root, tools } = await fixture(t);
    await mkdir(path.join(root, 'tests'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: testScript, build: 'echo build' } }),
    );
    const file = path.join(root, 'tests', 'sample.test.mjs');
    await writeFile(
      file,
      "import test from 'node:test'; import { writeFileSync } from 'node:fs';\n" +
        "test('passes untouched', () => { writeFileSync('passed.marker', 'ran'); });\n" +
        "test('fails [first]', () => { throw new Error('not yet'); });\n",
    );
    let description = '';
    const first = await tools.execute(
      call('run_validation', { id: 'npm:test', files: ['tests/sample.test.mjs'] }),
      {
        ...ctx(),
        approve: async (approval) => {
          description = approval.description;
          return true;
        },
      },
    );
    assert.equal(first.isError, true);
    assert.match(description, /sample\.test\.mjs/);
    const firstResult = JSON.parse(first.content);
    assert.equal(firstResult.exitCode, 1);
    assert.deepEqual(firstResult.failedTests, ['fails [first]']);
    assert.equal(await readFile(path.join(root, 'passed.marker'), 'utf8'), 'ran');

    await rm(path.join(root, 'passed.marker'));
    await writeFile(
      file,
      "import test from 'node:test'; import { writeFileSync } from 'node:fs';\n" +
        "test('passes untouched', () => { writeFileSync('passed.marker', 'ran'); });\n" +
        "test('fails [first]', () => { writeFileSync('fixed.marker', 'ran'); });\n",
    );
    const retried = await tools.execute(
      call('run_validation', {
        id: 'npm:test',
        files: ['tests/sample.test.mjs'],
        failed_test_names: firstResult.failedTests,
      }),
      ctx(),
    );
    assert.equal(retried.isError, false, retried.content);
    assert.equal(JSON.parse(retried.content).counts.pass, 1);
    assert.equal(await readFile(path.join(root, 'fixed.marker'), 'utf8'), 'ran');
    await assert.rejects(access(path.join(root, 'passed.marker')));
  });
}

test('targeted validation shows a sandbox-local Node command before approval', async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'tests'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } }),
  );
  await writeFile(
    path.join(root, 'tests', 'one.test.mjs'),
    "import test from 'node:test'; test('ok', () => {});",
  );
  const previous = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  try {
    let description = '';
    const result = await tools.execute(
      call('run_validation', { id: 'npm:test', files: ['tests/one.test.mjs'] }),
      {
        ...ctx(),
        approve: async (approval) => {
          description = approval.description;
          return false;
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(description, /Resolved command: node --test/);
    assert.doesNotMatch(description, /node\.exe/);
  } finally {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
  }
});

test('validation keeps structured evidence parseable when output is long', async (t) => {
  const { root, tools } = await fixture(t);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(\'x\'.repeat(100000))"' } }),
  );
  const result = await tools.execute(call('run_validation', { id: 'npm:test' }), ctx());
  assert.equal(result.isError, false, result.content);
  const evidence = JSON.parse(result.content);
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.outputTruncated, true);
  assert.ok(evidence.output.length < 24000);
});

test('targeted validation refuses escaping and unsupported test files before approval', async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'tests'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs', build: 'echo build' } }),
  );
  await writeFile(
    path.join(root, 'tests', 'one.test.mjs'),
    "import test from 'node:test'; test('ok', () => {});",
  );
  let approvals = 0;
  const context = {
    ...ctx(),
    approve: async () => {
      approvals++;
      return true;
    },
  };
  for (const args of [
    { id: 'npm:test', files: ['../outside.test.mjs'] },
    { id: 'npm:test', files: ['C:escape.test.mjs'] },
    { id: 'npm:test', files: ['package.json'] },
    { id: 'npm:build', files: ['tests/one.test.mjs'] },
    { id: 'npm:test', files: ['tests/one.test.mjs'], failed_test_names: [''] },
  ]) {
    const result = await tools.execute(call('run_validation', args), context);
    assert.equal(result.isError, true, result.content);
  }
  assert.equal(approvals, 0);
});

test('validation discovery ignores symlinked manifests', async (t) => {
  const { root, tools } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-validation-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    path.join(outside, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo escaped' } }),
  );
  await symlink(
    path.join(outside, 'package.json'),
    path.join(root, 'package.json'),
    process.platform === 'win32' ? 'file' : undefined,
  );
  const discovered = await tools.execute(call('discover_validations', {}), ctx());
  assert.doesNotMatch(discovered.content, /npm:test/);
});

test('approved mutation rejects a final-path symlink swap', async (t) => {
  const { root, tools } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-mutation-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(root, 'target.txt'), 'inside');
  await writeFile(path.join(outside, 'target.txt'), 'outside');
  const result = await tools.execute(
    call('edit_file', { path: 'target.txt', old_text: 'inside', new_text: 'changed' }),
    {
      ...ctx(),
      approve: async () => {
        await rm(path.join(root, 'target.txt'));
        await symlink(
          path.join(outside, 'target.txt'),
          path.join(root, 'target.txt'),
          process.platform === 'win32' ? 'file' : undefined,
        );
        return true;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(await readFile(path.join(outside, 'target.txt'), 'utf8'), 'outside');
});

test('approval exposes the entire executable command including long suffixes', async (t) => {
  const { tools } = await fixture(t);
  const command = 'echo ' + 'a'.repeat(9000) + ' & echo HIDDEN_SUFFIX';
  let description = '';
  const result = await tools.execute(call('run_command', { command }), {
    ...ctx(),
    approve: async (approval) => {
      description = approval.description;
      return false;
    },
  });
  assert.equal(result.isError, true);
  assert.ok(description.includes('HIDDEN_SUFFIX'));
  assert.ok(description.includes(command));
});

test('a command that outgrows its collection says so instead of claiming to be whole', async (t) => {
  /**
   * `run_command` bounds what it collects at two megabytes — deliberately above the result budget, so the result
   * stage has something worth writing out — which makes its text short of what the command actually printed. The
   * flag is how that reaches the result stage; without it the spill notice promised "the full N bytes" about a tail
   * that no longer existed, which is the case the item is about. Two megabytes is the real limit, so this runs a
   * real command rather than a stub.
   */
  const { tools } = await fixture(t);
  const result = await tools.execute(
    call('run_command', { command: `node -e "process.stdout.write('x'.repeat(2200000))"` }),
    ctx(),
  );
  assert.equal(result.isError, false, result.content.slice(0, 200));
  assert.equal(result.truncated, true, 'the tool declares that it cut its own output');
  /**
   * The text itself is bounded to the inline budget here, and the sentence that says so is past the cut — which is
   * exactly why the fact cannot live in the prose: the code that decides whether to spill reads the result, not a
   * sentence 24,000 characters in. What the *notice* does with the flag when there is somewhere to spill is
   * `tests/spill.test.ts`'s case.
   */
  assert.equal(result.content.length < 2200000, true, 'the result the model reads is bounded');
});

test('shell commands preserve nested quotes and executable paths containing spaces', async (t) => {
  const { tools } = await fixture(t);
  const script = await tools.execute(
    call('run_command', { command: 'node -e "console.log(42)"' }),
    ctx(),
  );
  assert.equal(script.isError, false);
  assert.match(JSON.parse(script.content).output, /42/);
  const executable = await tools.execute(
    call('run_command', { command: `"${process.execPath}" --version` }),
    ctx(),
  );
  assert.equal(executable.isError, false, executable.content);
  assert.equal(JSON.parse(executable.content).output.trim(), process.version);
});

/**
 * Regression: merged scoped instructions over the tool-output budget used to throw before the
 * text was recorded as "already shown", so every later call threw again and the whole subtree
 * became unreachable — including the instruction file that needed shortening, because reading it
 * resolves to the same directory. The notice is trimmed now, so the subtree stays usable.
 */
const scopedMarker = 'SCOPED-INSTRUCTION-MARKER';
async function overBudgetInstructionFixture(t: test.TestContext) {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'sub'), { recursive: true });
  // 25000 characters: accepted by loadInstructions (32KB per file) but over the 18000 notice budget.
  await writeFile(path.join(root, 'sub', 'AGENTS.md'), `${scopedMarker}\n${'x'.repeat(25000)}`);
  await writeFile(path.join(root, 'sub', 'target.txt'), 'original\n');
  return { root, tools };
}

test('over-budget scoped instructions are trimmed rather than blocking reads in that directory', async (t) => {
  const { tools } = await overBudgetInstructionFixture(t);
  const read = await tools.execute(call('read_file', { path: 'sub/target.txt' }), ctx());
  assert.equal(read.isError, false, read.content);
  // The model still receives the guidance, bounded, instead of an error.
  assert.match(read.content, new RegExp(scopedMarker));
  assert.match(read.content, /Scoped instructions truncated/);
  assert.match(read.content, /original/);
  assert.ok(
    read.content.length < 24000,
    `guidance must stay within the notice budget, got ${read.content.length}`,
  );
  // Recorded as shown, so it is not repeated on the next call.
  const again = await tools.execute(call('read_file', { path: 'sub/target.txt' }), ctx());
  assert.equal(again.isError, false, again.content);
  assert.doesNotMatch(again.content, new RegExp(scopedMarker));
  assert.match(again.content, /original/);
});

test('over-budget scoped instructions still gate a mutation once, then allow it', async (t) => {
  const { root, tools } = await overBudgetInstructionFixture(t);
  const edit = () =>
    tools.execute(
      call('edit_file', { path: 'sub/target.txt', old_text: 'original', new_text: 'changed' }),
      ctx(),
    );
  const gate = await edit();
  assert.equal(gate.isError, true);
  // The one-time "read the instructions first" gate — not a permanent budget error.
  assert.match(gate.content, /Read the applicable project instructions before retrying/);
  assert.match(gate.content, /Scoped instructions truncated/);
  // What the model does next, and now has to: read the file it is about to change. The instruction text itself
  // is already recorded as shown (the refused edit recorded it), so the read carries no new notice — it is the
  // observation gate that this step satisfies.
  const read = await tools.execute(call('read_file', { path: 'sub/target.txt' }), ctx());
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /original/);
  const applied = await edit();
  assert.equal(applied.isError, false, applied.content);
  assert.equal(await readFile(path.join(root, 'sub', 'target.txt'), 'utf8'), 'changed\n');
});
