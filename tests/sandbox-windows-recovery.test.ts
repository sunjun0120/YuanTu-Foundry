import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../packages/tools/write-all.ts';
import { workspaceSandboxSid } from '../packages/tools/sandbox-windows.ts';
import { toolEnvironment } from '../packages/tools/environment.ts';

const helper = fileURLToPath(new URL('../packages/tools/windows-sandbox/acl.ps1', import.meta.url));
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
const executeFile = promisify(execFile);
const run = (executable: string, args: string[]) =>
  executeFile(executable, args, { env: toolEnvironment() });
const windows = { skip: process.platform !== 'win32' };
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-winsandbox-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const journal = path.join(directory, 'journal.json');
  const operation = (name: string) =>
    run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
      '-Operation',
      name,
      '-Root',
      root,
      '-Journal',
      journal,
      '-Sid',
      workspaceSandboxSid(root),
    ]);
  return { root, journal, operation };
}

test(
  'approved atomic replacement with the same effective label permits ACL recovery',
  windows,
  async (t) => {
    const { root, operation } = await fixture(t);
    const file = path.join(root, 'edited.txt');
    await writeFile(file, 'before');
    const before = (await run('icacls.exe', [file])).stdout;
    await operation('grant');
    await atomicWriteFile(file, Buffer.from('approved edit'));
    await operation('restore');
    assert.equal(await readFile(file, 'utf8'), 'approved edit');
    assert.equal((await run('icacls.exe', [file])).stdout, before);
  },
);

test(
  'recovery keeps its journal and applies nothing when an actual ACL changes',
  windows,
  async (t) => {
    const { root, journal, operation } = await fixture(t);
    const file = path.join(root, 'operator.txt');
    await writeFile(file, 'keep');
    await operation('grant');
    const rootBefore = (await run('icacls.exe', [root])).stdout;
    await run('icacls.exe', [file, '/grant', '*S-1-5-11:R', '/Q']);
    const operatorAcl = (await run('icacls.exe', [file])).stdout;
    await assert.rejects(operation('restore'), /ACL changed during sandbox execution/);
    assert.ok(await stat(journal));
    assert.equal((await run('icacls.exe', [file])).stdout, operatorAcl);
    assert.equal(
      (await run('icacls.exe', [root])).stdout,
      rootBefore,
      'recovery must validate every entry before any write',
    );
  },
);

test('recovery refuses an operator change to the mandatory integrity level', windows, async (t) => {
  const { root, journal, operation } = await fixture(t);
  const file = path.join(root, 'operator-label.txt');
  await writeFile(file, 'keep');
  await operation('grant');
  const rootBefore = (await run('icacls.exe', [root])).stdout;
  const source = await readFile(helper, 'utf8');
  const declarations = source.slice(
    source.indexOf('$ErrorActionPreference'),
    source.indexOf('function Safe-Tree'),
  );
  const fileLiteral = `'${file.replaceAll("'", "''")}'`;
  const changeLabel = `${declarations}\n$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([YuantuAcl]::Capture(${fileLiteral})); [YuantuAcl]::Apply(${fileLiteral}, $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access) + 'S:(ML;;NW;;;ME)'); [YuantuAcl]::Capture(${fileLiteral})`;
  const native = await run(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(changeLabel, 'utf16le').toString('base64'),
  ]);
  assert.match(native.stdout, /S:.*;;;ME\)/, 'fixture changed the real mandatory-label SID');
  const operatorLabel = (await run('icacls.exe', [file])).stdout;
  assert.match(operatorLabel, /Medium Mandatory Level/, 'fixture must actually change the label');
  await assert.rejects(operation('restore'), /ACL changed during sandbox execution/);
  assert.ok(await stat(journal));
  assert.equal((await run('icacls.exe', [file])).stdout, operatorLabel);
  assert.equal((await run('icacls.exe', [root])).stdout, rootBefore);
});
