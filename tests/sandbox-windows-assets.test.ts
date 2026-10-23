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
import { labelLowIntegrity } from './windows-label-fixture.ts';

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
    await labelLowIntegrity(second);
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
test(
  'an owner without WRITE_OWNER gets its workspace back exactly as it was',
  { skip: unavailable ?? false },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-owner-'));
    const execute = promisify(execFile);
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const icacls = path.join(system32, 'icacls.exe');
    // A failed run can leave descriptors this process may not delete through; reset them before removing.
    t.after(async () => {
      await execute(icacls, [root, '/reset', '/T', '/C', '/Q'], { windowsHide: true }).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
    });
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    // The shape of a directory outside the profile: Authenticated Users may modify, the owner holds no WRITE_OWNER.
    await execute(
      icacls,
      [workspace, '/inheritance:r', '/grant', '*S-1-5-11:(OI)(CI)M', '*S-1-5-18:(OI)(CI)F', '/Q'],
      { windowsHide: true },
    );
    const nested = path.join(workspace, 'nested');
    await mkdir(nested);
    const existing = path.join(nested, 'existing.txt');
    await writeFile(existing, 'before');
    const created = path.join(nested, 'created.txt');
    const sddl = async (target: string) =>
      (
        await execute(
          path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-Command',
            `(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').Sddl`,
          ],
          { windowsHide: true },
        )
      ).stdout.trim();
    const targets = [workspace, nested, existing];
    const before = await Promise.all(targets.map(sddl));
    const { windowsSandboxProvider } = await import('../packages/tools/sandbox-windows.ts');
    const plan = await windowsSandboxProvider.prepare({
      root: workspace,
      cwd: workspace,
      command: process.execPath,
      argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(created)}, 'new')`],
      config: { mode: 'windows', image: 'native' },
    });
    try {
      // The grant keeps every inherited ACE: only an explicit WRITE_OWNER for the owner is added.
      assert.match(await sddl(existing), /\(A;ID;0x1301bf;;;AU\)/);
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
      assert.equal(code, 0, 'the sandboxed command could write inside the workspace');
    } finally {
      await windowsSandboxProvider.cleanup(plan);
    }
    assert.deepEqual(await Promise.all(targets.map(sddl)), before);
    // A file the command created inherits the workspace's DACL, not the owner's WRITE_OWNER grant.
    assert.doesNotMatch(await sddl(created), /;WO;/);
  },
);
