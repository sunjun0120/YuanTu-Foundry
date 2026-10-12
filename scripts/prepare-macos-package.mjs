import { copyFile, chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const licenseHeader = 'Node.js is licensed for use as follows:';
const run = promisify(execFile);

/** Copying a Homebrew-linked Node alone does not make a standalone app runtime. */
export function assertMacRuntimeDependencies(listing) {
  const libraries = [...listing.matchAll(/^\s+(.+?)\s+\(compatibility version [^\n]+\)$/gm)].map(
    (match) => match[1],
  );
  if (!libraries.length) throw new Error('Invalid macOS runtime dependency listing');
  for (const library of libraries) {
    const canonical = path.posix.normalize(library);
    if (!canonical.startsWith('/usr/lib/') && !canonical.startsWith('/System/Library/'))
      throw new Error(
        `Bundled Node requires an external dynamic library: ${library}; use a standalone Node distribution`,
      );
  }
}

export async function validateMacRuntimeDependencies(nodePath) {
  const { stdout } = await run('/usr/bin/otool', ['-L', nodePath], { timeout: 10000 });
  assertMacRuntimeDependencies(stdout);
}

/** Called before any writes or downloads, including when electron-builder is invoked directly. */
export function assertMacRuntime(host, targetArchitecture) {
  if (host.platform !== 'darwin') throw new Error('macOS packaging requires a macOS host');
  if (!['arm64', 'x64'].includes(targetArchitecture) || host.arch !== targetArchitecture)
    throw new Error(
      'macOS package architecture must match the standalone Node architecture (arm64 or x64)',
    );
  if (!/^\d+\.\d+\.\d+$/.test(host.nodeVersion) || Number(host.nodeVersion.split('.')[0]) < 24)
    throw new Error('macOS packaging requires Node.js >=24');
  if (host.electronVersion)
    throw new Error('macOS packaging requires standalone Node, not Electron');
}

/** Reject stale Windows/other-architecture staging and changed bytes before packaging. */
export async function validateMacRuntime(directory, targetArchitecture) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  assertMacRuntime(
    { platform: manifest.platform, arch: manifest.architecture, nodeVersion: manifest.nodeVersion },
    targetArchitecture,
  );
  const nodePath = path.join(directory, 'node');
  const stat = await lstat(nodePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Bundled Node must be a regular file');
  if (process.platform === 'darwin' && (stat.mode & 0o111) === 0)
    throw new Error('Bundled Node must be executable');
  if (digest(await readFile(nodePath)) !== manifest.sha256)
    throw new Error('Bundled Node hash does not match runtime manifest');
  const license = await readFile(path.join(directory, 'LICENSE.node'), 'utf8');
  if (!license.startsWith(licenseHeader) || digest(license) !== manifest.licenseSha256)
    throw new Error('Bundled Node license does not match runtime manifest');
  return manifest;
}

export async function prepareMacRuntime(targetArchitecture = process.arch) {
  assertMacRuntime(
    {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    },
    targetArchitecture,
  );
  await validateMacRuntimeDependencies(process.execPath);
  const directory = path.resolve('.scratch/packaging/runtime');
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  let licenseText;
  try {
    const previous = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
    const cached = await readFile(path.join(directory, 'LICENSE.node'), 'utf8');
    if (
      previous.nodeVersion === process.versions.node &&
      previous.licenseUrl === licenseUrl &&
      cached.startsWith(licenseHeader) &&
      digest(cached) === previous.licenseSha256
    )
      licenseText = cached;
  } catch {
    // A new runtime needs its own complete upstream distribution license.
  }
  if (!licenseText) {
    const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
    if (!license.ok)
      throw new Error(`Unable to obtain Node distribution license: ${license.status}`);
    licenseText = await license.text();
    if (!licenseText.startsWith(licenseHeader))
      throw new Error('Invalid Node distribution license');
  }
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, path.join(directory, 'node'));
  await chmod(path.join(directory, 'node'), 0o755);
  // The same staging path may previously have been used by the Windows package command.
  await unlink(path.join(directory, 'node.exe')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await writeFile(path.join(directory, 'LICENSE.node'), licenseText);
  await writeFile(
    path.join(directory, 'runtime.json'),
    JSON.stringify(
      {
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        sha256: digest(await readFile(process.execPath)),
        licenseUrl,
        licenseSha256: digest(licenseText),
      },
      null,
      2,
    ) + '\n',
  );
  // Electron and the independent Node/V8 process both execute generated code.
  await writeFile(
    path.join(directory, '../entitlements.mac.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`,
  );
  await validateMacRuntime(directory, targetArchitecture);
  console.log(`Prepared bundled Node ${process.versions.node} for macOS ${targetArchitecture}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !/^--arch=(arm64|x64)$/.test(args[0])))
    throw new Error('Usage: node scripts/prepare-macos-package.mjs [--arch=arm64|x64]');
  await prepareMacRuntime(args[0]?.slice('--arch='.length));
}
