import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

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
  assert.ok(
    macro.includes(
      String.raw`$INSTDIR\resources\app\dist\packages\tools\windows-sandbox\yuantu-sandbox.exe`,
    ),
  );
  assert.match(macro, /nsExec::Exec '"\$R0" account-uninstall'/);
  const names = await readFile('packages/tools/windows-sandbox/native/src/account/mod.rs', 'utf8');
  for (const constant of ['OFFLINE', 'ONLINE', 'GROUP']) {
    const name = new RegExp(`pub const ${constant}: &str = "([^"]+)";`).exec(names)?.[1];
    assert.ok(name, constant);
    assert.ok(macro.includes(` ${name}'`), `${constant} (${name}) is checked before uninstalling`);
  }
});
