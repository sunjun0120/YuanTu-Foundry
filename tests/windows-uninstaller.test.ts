import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tempRoot } from './temp-fixture.ts';

/**
 * The uninstaller is the only place the Windows sandbox accounts are removed, and NSIS cannot be run here, so this
 * pins the script to the names it depends on: the accounts the helper creates, where the package puts the helper,
 * and the update guard that keeps every update from tearing the accounts down.
 */
const config = createRequire(import.meta.url)('../electron-builder.config.cjs');

test('the NSIS uninstaller removes the sandbox accounts, but never during an update', async () => {
  assert.equal(config.nsis.include, 'build/installer.nsh');
  const bytes = await readFile('build/installer.nsh');
  // makensis reads an included file without a BOM in the system code page, which garbles the Chinese message.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const script = bytes.toString('utf8');
  const macro = script.slice(script.indexOf('!macro customUnInstall'));
  assert.match(macro, /^\s*\$\{ifNot\} \$\{isUpdated\}/m);
  assert.match(macro, /nsExec::Exec '"\$R0" account-uninstall'/);
  const names = await readFile(
    'packages/sandbox/windows-sandbox/native/src/account/mod.rs',
    'utf8',
  );
  for (const constant of ['OFFLINE', 'ONLINE', 'GROUP']) {
    const name = new RegExp(`pub const ${constant}: &str = "([^"]+)";`).exec(names)?.[1];
    assert.ok(name, constant);
    assert.ok(macro.includes(` ${name}'`), `${constant} (${name}) is checked before uninstalling`);
  }
});

test('the uninstall helper exists in a freshly staged sandbox bundle', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'packages/sandbox/windows-sandbox');
  await mkdir(source, { recursive: true });
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(source, 'acl.ps1'), '# fixture');
  await writeFile(path.join(source, 'yuantu-sandbox.exe'), 'fixture helper');
  const staging = path.join(root, 'scripts/copy-sandbox-assets.mjs');
  await copyFile('scripts/copy-sandbox-assets.mjs', staging);
  execFileSync(process.execPath, [staging], { cwd: root, windowsHide: true });

  const script = await readFile(config.nsis.include, 'utf8');
  const relative = /StrCpy \$R0 "\$INSTDIR\\resources\\app\\([^"]+)"/.exec(script)?.[1];
  assert.ok(relative, 'the uninstaller names a helper inside the installed application');
  assert.equal(
    await readFile(path.join(root, ...relative.split('\\')), 'utf8'),
    'fixture helper',
    'the uninstaller reaches the helper produced by staging, without stale build files',
  );
});
