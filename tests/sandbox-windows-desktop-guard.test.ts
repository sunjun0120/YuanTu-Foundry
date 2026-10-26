import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareSandbox } from '../packages/tools/sandbox.ts';
import { EnvironmentBlockedError } from '../packages/tools/environment-blocked.ts';

const execute = promisify(execFile);
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * A workspace grant labels the whole tree Low integrity. When that tree holds the running desktop — the development
 * checkout opened as its own workspace — Windows then starts Electron at Low integrity, where Chromium crashes before
 * any window exists. The grant is refused before any permission changes, with a reason a person can act on.
 */
test(
  'the Windows sandbox refuses a workspace that contains the desktop executable',
  { skip: process.platform !== 'win32' && 'Windows sandbox only' },
  async (t) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'yuantu-desktop-guard-'));
    const executable = path.join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '');
    const previous = process.env.YUANTU_DESKTOP_EXECUTABLE;
    process.env.YUANTU_DESKTOP_EXECUTABLE = executable;
    t.after(async () => {
      if (previous === undefined) delete process.env.YUANTU_DESKTOP_EXECUTABLE;
      else process.env.YUANTU_DESKTOP_EXECUTABLE = previous;
      await rm(workspace, { recursive: true, force: true });
    });
    const rejected = await prepareSandbox(workspace, workspace, 'exit 0', undefined, {
      mode: 'windows',
      image: 'node:24-bookworm-slim',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(rejected instanceof EnvironmentBlockedError, String(rejected));
    assert.equal(rejected.code, 'windows-sandbox-workspace-contains-desktop');
    assert.ok(rejected.message.includes(executable), rejected.message);
    assert.match(rejected.message, /Low integrity/);
    // Refused before the grant: the workspace keeps its original label.
    const { stdout } = await execute(path.join(system32, 'icacls.exe'), [workspace], {
      windowsHide: true,
    });
    assert.doesNotMatch(stdout, /Low Mandatory Level/);
  },
);
