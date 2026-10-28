import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validatePackagedWindowsRuntime } from './windows-runtime-product.mjs';
import { assertWindowsRuntime, inspectWindowsRuntime } from './windows-runtime.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(
  await readFile(path.join(project, 'build/windows-runtime.lock.json'), 'utf8'),
);
export async function validateWindowsPackage(directory, { inspect = true } = {}) {
  const resources = path.join(directory, 'resources');
  const manifest = await validatePackagedWindowsRuntime(path.join(resources, 'runtime'));
  const staged = await validatePackagedWindowsRuntime(
    path.join(project, '.scratch/packaging/runtime'),
  );
  if (
    manifest.sha256 !== staged.sha256 ||
    manifest.provenanceSha256 !== staged.provenanceSha256 ||
    manifest.licenseSha256 !== staged.licenseSha256
  )
    throw new Error('Packaged runtime differs from the explicitly prepared runtime');
  if (manifest.selection === 'candidate') {
    const provenance = JSON.parse(
      await readFile(path.join(resources, 'runtime/provenance.json'), 'utf8'),
    );
    if (
      provenance.source?.version !== lock.nodeVersion ||
      provenance.source?.sha256 !== lock.archive.sha256 ||
      provenance.source?.releaseSigner !== lock.releaseSigner ||
      provenance.binary?.sha256 !== lock.executableSha256 ||
      provenance.binary?.licenseSHA256 !== lock.licenseSha256
    )
      throw new Error('Packaged Node provenance differs from the locked official release');
  }
  const helperHashes = {};
  for (const name of ['yuantu-sandbox.exe', 'acl.ps1']) {
    const relative = `dist/packages/sandbox/windows-sandbox/${name}`;
    const packaged = path.join(resources, 'app', relative);
    const digest = sha256(await readFile(packaged));
    if (digest !== sha256(await readFile(path.join(project, relative))))
      throw new Error(`Packaged helper asset differs from prepared asset: ${name}`);
    helperHashes[name] = digest;
  }
  await readFile(path.join(resources, 'app/dist/apps/agent-host/main.js'));
  // The entry the desktop actually launches: one bundled file. The compiled entry stays (tests and a tsc-only
  // checkout use it), but a package without the bundle would pay the module-resolution cost on every launch.
  const bundledHost = path.join(resources, 'app/dist/packages/tools/host.bundle.js');
  if ((await stat(bundledHost)).size < 1024 * 1024)
    throw new Error('Packaged Host bundle is missing or truncated');
  // Office automation inlined into the bundle looks for its script beside the bundle, not under `dist/packages/office`.
  await readFile(path.join(resources, 'app/dist/packages/tools/automation.ps1'));
  const metadata = JSON.parse(await readFile(path.join(resources, 'app/package.json'), 'utf8'));
  if (metadata.main !== 'dist/desktop/main.cjs')
    throw new Error('Packaged desktop entry point changed');
  if (!metadata.dependencies?.typescript)
    throw new Error('Packaged symbol indexing requires TypeScript as a runtime dependency');
  const compilerMetadata = JSON.parse(
    await readFile(path.join(resources, 'app/node_modules/typescript/package.json'), 'utf8'),
  );
  await readFile(path.join(resources, 'app/node_modules/typescript/lib/typescript.js'));
  // Excluded by `electron-builder.config.cjs`: a rendering polyfill the desktop never uses, and 36 MB of native code.
  for (const excluded of ['@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc'])
    if (await stat(path.join(resources, 'app/node_modules', excluded)).catch(() => null))
      throw new Error(`Packaged app still contains ${excluded}`);
  // Inlined by the bundles, so packaging a copy means a runtime import escaped them (see `electron-builder.config.cjs`).
  for (const bundled of ['docx', 'jszip', 'mammoth', 'pptxgenjs', 'xlsx'])
    if (await stat(path.join(resources, 'app/node_modules', bundled)).catch(() => null))
      throw new Error(`Packaged app still contains bundled dependency ${bundled}`);
  for (const entry of ['pdf.mjs', 'pdf.worker.mjs'])
    await readFile(path.join(resources, 'app/node_modules/pdfjs-dist/legacy/build', entry));
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
    runtime: manifest,
    helperHashes,
    inspected: info,
    symbolCompiler: compilerMetadata.version,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !arg.startsWith('--directory='))) throw new Error('Use --directory=path');
  const directory = path.resolve(
    args.find((arg) => arg.startsWith('--directory='))?.slice(12) || 'dist/release/win-unpacked',
  );
  const report = await validateWindowsPackage(directory);
  const output = path.join(project, '.scratch/windows-package-check');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`Verified packaged Node ${report.runtime.nodeVersion}: ${report.runtime.sha256}`);
}
