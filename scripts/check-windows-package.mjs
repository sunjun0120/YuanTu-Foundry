import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validatePackagedWindowsRuntime } from './windows-runtime-product.mjs';
import { assertWindowsRuntime, inspectWindowsRuntime } from './windows-runtime.mjs';
import {
  assertPinnedHelperManifest,
  inspectHelperSignature,
} from './check-windows-appcontainer.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
export async function validateWindowsPackage(
  directory,
  { production = false, inspect = true } = {},
) {
  const resources = path.join(directory, 'resources');
  const manifest = await validatePackagedWindowsRuntime(path.join(resources, 'runtime'), {
    production,
  });
  const staged = await validatePackagedWindowsRuntime(
    path.join(project, '.scratch/packaging/runtime'),
    { production },
  );
  if (
    manifest.sha256 !== staged.sha256 ||
    manifest.provenanceSha256 !== staged.provenanceSha256 ||
    manifest.licenseSha256 !== staged.licenseSha256
  )
    throw new Error('Packaged runtime differs from the explicitly prepared runtime');
  const helperHashes = {};
  if (production) {
    const signature = await inspectHelperSignature(path.join(resources, 'runtime/node.exe'));
    if (
      !signature.valid ||
      !signature.timestamped ||
      signature.signerSha256 !== manifest.signedHelper?.signerSha256
    )
      throw new Error('Packaged production Node signature differs from pinned helper signer');
    const signingAsset = JSON.parse(
      await readFile(
        path.join(resources, 'app/dist/packages/tools/windows-sandbox/helper-signature.json'),
        'utf8',
      ),
    );
    if (JSON.stringify(signingAsset) !== JSON.stringify(manifest.signedHelper))
      throw new Error('Packaged helper signing manifest was not preserved');
  }
  for (const name of ['yuantu-appcontainer.exe', 'acl.ps1', 'appcontainer-acl.ps1']) {
    const relative = `dist/packages/tools/windows-sandbox/${name}`;
    const packaged = path.join(resources, 'app', relative);
    const digest = sha256(await readFile(packaged));
    if (digest !== sha256(await readFile(path.join(project, relative))))
      throw new Error(`Packaged helper asset differs from prepared asset: ${name}`);
    helperHashes[name] = digest;
    if (production && name.endsWith('.exe'))
      assertPinnedHelperManifest(
        manifest.signedHelper,
        await inspectHelperSignature(packaged),
        digest,
      );
  }
  await readFile(path.join(resources, 'app/dist/apps/agent-host/main.js'));
  // The entry the desktop actually launches: one bundled file. The compiled entry stays (tests and a tsc-only
  // checkout use it), but a package without the bundle would pay the module-resolution cost on every launch.
  const bundledHost = path.join(resources, 'app/dist/packages/tools/host.bundle.js');
  if ((await stat(bundledHost)).size < 1024 * 1024)
    throw new Error('Packaged Host bundle is missing or truncated');
  const metadata = JSON.parse(await readFile(path.join(resources, 'app/package.json'), 'utf8'));
  if (metadata.main !== 'dist/desktop/main.cjs')
    throw new Error('Packaged desktop entry point changed');
  if (!metadata.dependencies?.typescript)
    throw new Error('Packaged symbol indexing requires TypeScript as a runtime dependency');
  const compilerMetadata = JSON.parse(
    await readFile(path.join(resources, 'app/node_modules/typescript/package.json'), 'utf8'),
  );
  await readFile(path.join(resources, 'app/node_modules/typescript/lib/typescript.js'));
  const info = inspect
    ? await inspectWindowsRuntime(path.join(resources, 'runtime/node.exe'))
    : null;
  if (info) {
    assertWindowsRuntime(info);
    if (info.nodeVersion !== manifest.nodeVersion || info.uv !== manifest.uvVersion)
      throw new Error('Packaged runtime identity differs from recorded runtime');
  }
  return {
    checkedAt: new Date().toISOString(),
    directory,
    production,
    runtime: manifest,
    helperHashes,
    inspected: info,
    symbolCompiler: compilerMetadata.version,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--production' && !arg.startsWith('--directory=')))
    throw new Error('Use --directory=path and/or --production');
  const directory = path.resolve(
    args.find((arg) => arg.startsWith('--directory='))?.slice(12) || 'dist/release/win-unpacked',
  );
  const report = await validateWindowsPackage(directory, {
    production: args.includes('--production'),
  });
  const output = path.join(project, '.scratch/windows-package-check');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`Verified packaged Node ${report.runtime.nodeVersion}: ${report.runtime.sha256}`);
}
