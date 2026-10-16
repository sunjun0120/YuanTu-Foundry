// @test-serial windows-sandbox: Exercises real Windows sandbox ACLs and trusted control state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { windowsSandboxAvailable } from '../packages/tools/sandbox-windows.ts';
import type { SandboxProvider } from '../packages/tools/sandbox-provider.ts';

const unavailable = await windowsSandboxAvailable();

test(
  'batched control validation rejects an unsafe second directory',
  { skip: unavailable ?? false },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-control-batch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = path.join(root, 'first'),
      second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const execute = promisify(execFile);
    const powershell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('../packages/tools/windows-sandbox/acl.ps1', import.meta.url)),
      '-Operation',
      'validate-control',
      '-Root',
      first,
      '-Journal',
      path.join(root, 'unused-journal.json'),
      '-ControlRoots',
      second,
    ];
    await execute(powershell, args, { windowsHide: true });
    await execute('icacls.exe', [second, '/setintegritylevel', '(OI)(CI)L', '/Q'], {
      windowsHide: true,
    });
    await assert.rejects(
      execute(powershell, args, { windowsHide: true }),
      /Low integrity launcher cache/i,
    );
  },
);
test(
  'cleanup cannot execute a helper file edited by the guest',
  { skip: unavailable ?? false },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-assets-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, 'windows-sandbox'), { recursive: true });
    const original = new URL('../packages/tools/sandbox-windows.ts', import.meta.url);
    const source = (await readFile(original, 'utf8')).replace(
      /from '(\.\.?\/[^']+)'/g,
      (_, relative: string) => `from '${new URL(relative, original).href}'`,
    );
    const clone = path.join(workspace, 'sandbox-windows.ts');
    await writeFile(clone, source);
    const helper = path.join(workspace, 'windows-sandbox', 'acl.ps1');
    const helperSource = await readFile(
      new URL('../packages/tools/windows-sandbox/acl.ps1', import.meta.url),
      'utf8',
    );
    await writeFile(helper, helperSource);
    const provider: SandboxProvider = (await import(pathToFileURL(clone).href))
      .windowsSandboxProvider;
    const marker = path.join(root, 'host-code-executed.txt');
    const injected = `if ($Operation -eq 'restore') { [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'unsafe') }\n${helperSource}`;
    // Inject after param(...) so the ordinary cleanup still runs and restores its fixture ACLs.
    const paramEnd = helperSource.indexOf('\n') + 1;
    const tampered =
      helperSource.slice(0, paramEnd) +
      injected.slice(0, injected.indexOf('\n') + 1) +
      helperSource.slice(paramEnd);
    const plan = await provider.prepare({
      root: workspace,
      cwd: workspace,
      command: process.execPath,
      argv: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(helper)},${JSON.stringify(tampered)})`,
      ],
      config: { mode: 'windows', image: 'native' },
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          windowsHide: true,
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, 'guest modified its workspace copy of the helper');
    } finally {
      await provider.cleanup(plan);
    }
    await assert.rejects(
      stat(marker),
      { code: 'ENOENT' },
      'trusted cleanup must use its original helper snapshot',
    );
  },
);
