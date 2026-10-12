import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsSandboxAvailable } from '../packages/tools/sandbox-windows.ts';
import type { SandboxProvider } from '../packages/tools/sandbox-provider.ts';

const unavailable = await windowsSandboxAvailable();
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
      /from '(\.\/[^']+)'/g,
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
