import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareWindowsOutput } from '../scripts/prepare-windows-output.mjs';

const exec = promisify(execFile);
test(
  'generated executables launch at Medium integrity under a Low-labelled build parent',
  {
    skip: process.platform !== 'win32' && 'Windows mandatory integrity labels',
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-output-integrity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const identity = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    const sid = identity.stdout.match(/S-1-5-21-[0-9-]+/)?.[0];
    assert.ok(sid);
    await exec('icacls.exe', [root, '/grant', `*${sid}:(OI)(CI)F`], { windowsHide: true });
    await exec('icacls.exe', [root, '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true });
    const output = path.join(root, 'output');
    await prepareWindowsOutput(output);
    const executable = path.join(output, 'identity.exe');
    const original = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/whoami.exe');
    await copyFile(original, executable);
    const { stdout } = await exec(executable, ['/groups', '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    assert.match(
      stdout,
      /S-1-16-8192/,
      'generated executables must inherit Medium rather than Low integrity',
    );
    // The helper must not relabel its parent or existing unrelated files.
    const sibling = path.join(root, 'sibling');
    await mkdir(sibling);
    const siblingExecutable = path.join(sibling, 'identity.exe');
    await copyFile(original, siblingExecutable);
    const low = await exec(siblingExecutable, ['/groups', '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    assert.match(low.stdout, /S-1-16-4096/);
  },
);
