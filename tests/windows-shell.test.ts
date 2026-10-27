// @test-serial windows-sandbox: cancellation is measured while PowerShell starts; run alone so CPU contention cannot mask it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import {
  powershellScript,
  windowsShell,
  windowsShellArgs,
  windowsShellLabel,
} from '../packages/tools/windows-shell.ts';
import { executionEnvironment } from '../apps/shared/runtime.ts';
import { tempRoot } from './temp-fixture.ts';

/**
 * The PowerShell path, end to end.
 *
 * The runner pins the rest of the suite to cmd (`YUANTU_TEST_WINDOWS_SHELL=cmd`, see `scripts/test-isolation/environment.mjs`)
 * because a PowerShell start is several times slower under eight-way load; this file is where the shell models
 * actually get is exercised, so it switches the detection back on for its own process.
 */
process.env.YUANTU_TEST_WINDOWS_SHELL = 'auto';

const windowsOnly =
  process.platform !== 'win32' && 'PowerShell is the command shell on Windows only';

async function run(t: test.TestContext, command: string) {
  const root = await tempRoot(t, 'yuantu-windows-shell-');
  const tools = createTools(root);
  t.after(() => tools.close());
  const result = await tools.execute(
    { id: 'call-1', name: 'run_command', arguments: { command } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  return {
    root,
    result,
    body: JSON.parse(result.content) as { output: string; exitCode: number | null },
  };
}

test(
  'the test override pins cmd, and auto finds a PowerShell outside WindowsApps',
  { skip: windowsOnly },
  () => {
    assert.equal(windowsShell({ ...process.env, YUANTU_TEST_WINDOWS_SHELL: 'cmd' }).kind, 'cmd');
    const shell = windowsShell();
    assert.notEqual(shell.kind, 'cmd', 'every supported Windows ships Windows PowerShell');
    assert.doesNotMatch(shell.path, /[\\/]WindowsApps[\\/]/i);
    assert.match(windowsShellLabel(shell), /PowerShell/);
    assert.match(executionEnvironment(), /write PowerShell syntax/);
  },
);

test('a script asks for UTF-8 output, keeps exit codes and invokes a leading quoted path', () => {
  const script = powershellScript('node -v');
  assert.match(script, /OutputEncoding=\[System\.Text\.Encoding\]::UTF8/);
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.match(
    powershellScript('"C:\\Program Files\\x.exe" -v'),
    /\n& "C:\\Program Files\\x\.exe" -v\n/,
  );
  assert.deepEqual(windowsShellArgs({ kind: 'cmd', path: 'cmd.exe' }, 'echo hi'), [
    '/d',
    '/s',
    '/c',
    '"echo hi"',
  ]);
  const args = windowsShellArgs({ kind: 'powershell', path: 'powershell.exe' }, 'echo hi');
  assert.deepEqual(args.slice(0, 6), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
  ]);
});

test(
  'run_command keeps a native exit code through PowerShell',
  { skip: windowsOnly },
  async (t) => {
    const { result, body } = await run(t, 'node -e "process.exit(3)"');
    assert.equal(body.exitCode, 3, result.content);
    const explicit = await run(t, 'exit 7');
    assert.equal(explicit.body.exitCode, 7, explicit.result.content);
    const cmdlet = await run(t, 'Get-Item does-not-exist-here');
    assert.equal(cmdlet.body.exitCode, 1, cmdlet.result.content);
    // A later success is the answer, as in any shell: the earlier failure does not leak into the exit code.
    const later = await run(t, 'node -e "process.exit(2)"; node -e "process.exit(0)"');
    assert.equal(later.body.exitCode, 0, later.result.content);
  },
);

test(
  'run_command output is UTF-8 and PowerShell quoting reaches the program intact',
  { skip: windowsOnly },
  async (t) => {
    const { body } = await run(
      t,
      `Write-Output '你好，世界'; node -e "console.log('中文 ' + process.argv[1])" 'a "b" c'`,
    );
    assert.equal(body.exitCode, 0, body.output);
    assert.match(body.output, /你好，世界/);
    if (windowsShell().kind === 'powershell') {
      // Windows PowerShell 5.1 drops a double quote inside a native argument; the execution environment says to
      // escape it, and the escaped form does arrive.
      assert.match(body.output, /中文 a b c/);
      const escaped = await run(t, `node -e "console.log(process.argv[1])" 'a \\"b\\" c'`);
      assert.match(escaped.body.output, /^a "b" c$/m, escaped.body.output);
    } else assert.match(body.output, /中文 a "b" c/);
  },
);

test(
  'run_command runs a quoted executable path and an npm shim',
  { skip: windowsOnly },
  async (t) => {
    const executable = await run(t, `"${process.execPath}" --version`);
    assert.equal(executable.body.output.trim(), process.version, executable.result.content);
    // `npm` resolves to `npm.ps1` in PowerShell, which the default execution policy refuses without `-ExecutionPolicy Bypass`.
    const npm = await run(t, 'npm --version');
    assert.equal(npm.body.exitCode, 0, npm.result.content);
    assert.match(npm.body.output, /^\d+\.\d+\.\d+/m);
  },
);

test(
  'PowerShell variables and pipelines work in the workspace',
  { skip: windowsOnly },
  async (t) => {
    const root = await tempRoot(t, 'yuantu-windows-shell-files-');
    await writeFile(path.join(root, 'a.txt'), 'alpha\n');
    await writeFile(path.join(root, 'b.txt'), 'beta\n');
    const tools = createTools(root);
    t.after(() => tools.close());
    const result = await tools.execute(
      {
        id: 'call-1',
        name: 'run_command',
        arguments: {
          command:
            '$env:YT_PROBE = "set"; (Get-ChildItem *.txt | Measure-Object).Count; $env:YT_PROBE',
        },
      },
      { signal: new AbortController().signal, approve: async () => true },
    );
    const body = JSON.parse(result.content) as { output: string; exitCode: number };
    assert.equal(body.exitCode, 0, result.content);
    assert.match(body.output, /^2\s*$/m);
    assert.match(body.output, /^set\s*$/m);
  },
);

test(
  'cancelling a command while PowerShell is still starting it leaves no program behind',
  { skip: windowsOnly },
  async (t) => {
    // Under load roughly half of these used to leave `node` running after its shell was killed (see `killOrphans`).
    const root = await tempRoot(t, 'yuantu-windows-shell-cancel-');
    await writeFile(
      path.join(root, 'late.cjs'),
      'setTimeout(()=>require("fs").writeFileSync(process.argv[2],"bad"),2500);setInterval(()=>{},1000)',
    );
    const tools = createTools(root);
    t.after(() => tools.close());
    await Promise.all(
      [100, 150, 200, 250, 300, 350, 400, 500].map(async (delay, index) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), delay);
        try {
          await tools
            .execute(
              {
                id: `call-${index}`,
                name: 'run_command',
                arguments: { command: `node late.cjs late-${index}.txt` },
              },
              { signal: controller.signal, approve: async () => true },
            )
            .catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const leftovers = (await readdir(root)).filter((name) => name.startsWith('late-'));
    assert.deepEqual(leftovers, [], 'a cancelled program kept running and wrote its delayed file');
  },
);
