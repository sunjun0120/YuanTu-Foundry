import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  Number(process.versions.node.split('.')[0]) < 24
)
  throw new Error('Windows x64 packaging requires Windows x64 and Node.js >=24');
const directory = path.resolve('.scratch/packaging/runtime');
await mkdir(directory, { recursive: true });
await copyFile(process.execPath, path.join(directory, 'node.exe'));
// Include the complete upstream distribution license when redistributing Node.
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
let licenseText;
try {
  const previous = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  if (previous.nodeVersion === process.versions.node && previous.licenseUrl === licenseUrl) {
    const cached = await readFile(path.join(directory, 'LICENSE.node'), 'utf8');
    if (
      cached.startsWith('Node.js is licensed for use as follows:') &&
      (!previous.licenseSha256 ||
        previous.licenseSha256 === createHash('sha256').update(cached).digest('hex'))
    )
      licenseText = cached;
  }
} catch {
  /* A new runtime needs its own distribution license. */
}
if (!licenseText) {
  const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
  if (!license.ok) throw new Error(`Unable to obtain Node distribution license: ${license.status}`);
  licenseText = await license.text();
  if (!licenseText.startsWith('Node.js is licensed for use as follows:'))
    throw new Error('Invalid Node distribution license');
  await writeFile(path.join(directory, 'LICENSE.node'), licenseText);
}
await writeFile(
  path.join(directory, 'runtime.json'),
  JSON.stringify(
    {
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      sha256: createHash('sha256')
        .update(await readFile(process.execPath))
        .digest('hex'),
      licenseUrl,
      licenseSha256: createHash('sha256').update(licenseText).digest('hex'),
    },
    null,
    2,
  ),
);
console.log(`Prepared bundled Node ${process.versions.node} for Windows x64`);
