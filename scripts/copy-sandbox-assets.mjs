import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from './windows-runtime-product.mjs';
import {
  assertPinnedHelperManifest,
  inspectHelperSignature,
} from './check-windows-appcontainer.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const destination = path.join(project, 'dist/packages/tools/windows-sandbox');
await mkdir(destination, { recursive: true });
await copyFile(
  path.join(project, 'packages/tools/windows-sandbox/acl.ps1'),
  path.join(destination, 'acl.ps1'),
);
await copyFile(
  path.join(project, 'packages/tools/windows-sandbox/appcontainer-acl.ps1'),
  path.join(destination, 'appcontainer-acl.ps1'),
);
const nativeHelper = path.join(project, 'packages/tools/windows-sandbox/yuantu-appcontainer.exe');
const protectedRelease =
  process.env.WINDOWS_SANDBOX_PROTECTED_RELEASE === '1' ||
  process.env.WINDOWS_SANDBOX_APPCONTAINER_RELEASE === '1';
let helper;
try {
  helper = await readFile(nativeHelper);
} catch (error) {
  if (protectedRelease || error.code !== 'ENOENT') throw error;
}
if (helper) {
  let signing;
  if (protectedRelease) {
    signing = JSON.parse(
      (
        await readFile(path.join(project, '.scratch/windows-sandbox-signing/manifest.json'), 'utf8')
      ).replace(/^\uFEFF/, ''),
    );
    assertPinnedHelperManifest(signing, await inspectHelperSignature(nativeHelper), sha256(helper));
  }
  // Preserve signed bytes exactly across a clean TypeScript build.
  await writeFile(path.join(destination, 'yuantu-appcontainer.exe'), helper);
  // The sandbox account executor ships beside it when it was built (signing pins come with the protected release).
  const executor = path.join(project, 'packages/tools/windows-sandbox/yuantu-sandbox.exe');
  try {
    const bytes = await readFile(executor);
    if (signing)
      assertPinnedHelperManifest(
        signing,
        await inspectHelperSignature(executor),
        sha256(bytes),
        'yuantu-sandbox.exe',
      );
    await writeFile(path.join(destination, 'yuantu-sandbox.exe'), bytes);
  } catch (error) {
    if (signing || error.code !== 'ENOENT') throw error;
  }
  if (signing)
    await writeFile(
      path.join(destination, 'helper-signature.json'),
      JSON.stringify(signing, null, 2),
    );
}
