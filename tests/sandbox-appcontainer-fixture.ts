import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  markAppContainerStarted,
  stopAppContainer,
  prepareAppContainerDiagnostic,
} from '../packages/tools/sandbox-appcontainer.ts';
import type { SandboxPlan } from '../packages/tools/sandbox-provider.ts';

export const execute = promisify(execFile);

export const windows = { skip: process.platform !== 'win32', timeout: 120000 };

export async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yuantu-appcontainer-test-'));
  const root = path.join(parent, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'read.txt'), 'workspace');
  await writeFile(path.join(parent, 'private.txt'), 'private');
  return { parent, root };
}

export async function prepare(
  root: string,
  script: string,
  files: 'workspace-write' | 'read-only' = 'workspace-write',
) {
  return prepareAppContainerDiagnostic({
    root,
    cwd: root,
    command: process.execPath,
    argv: ['-e', script],
    config: { mode: 'appcontainer' as never, image: 'native', files, network: 'denied' },
  });
}

export async function run(plan: SandboxPlan, onCancellation = () => {}) {
  markAppContainerStarted(plan);
  let stopping: Promise<void> | undefined;
  const timer = setTimeout(() => {
    onCancellation();
    stopping = stopAppContainer(plan);
    void stopping.catch(() => {});
  }, 8000);
  return execute(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  })
    .catch((error) => {
      // Fixture output contains only the bounded test's diagnostics, never its environment.
      console.error('AppContainer fixture launch failed:', error.stderr, error.stdout);
      throw error;
    })
    .finally(async () => {
      clearTimeout(timer);
      if (stopping) await stopping;
    });
}
