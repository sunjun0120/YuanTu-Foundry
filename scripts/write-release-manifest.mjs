import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'dist');
const pkg = JSON.parse(
  await readFile(path.join(directory, 'win-unpacked/resources/app/package.json'), 'utf8'),
);
const artifact = `YuanTu-Agent-${pkg.version}-windows-x64-setup.exe`;
const file = path.join(directory, artifact);
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
const runtime = JSON.parse(
  await readFile(path.join(directory, 'win-unpacked/resources/runtime/runtime.json'), 'utf8'),
);
const release = JSON.parse(
  await readFile(
    path.join(directory, 'win-unpacked/resources/app/dist/desktop/release.json'),
    'utf8',
  ),
);
await writeFile(
  `${file}.json`,
  JSON.stringify(
    {
      format: 1,
      application: 'com.yuantu.agent',
      version: pkg.version,
      channel: 'manual',
      platform: 'win32',
      arch: 'x64',
      artifact,
      sha256: hash.digest('hex'),
      maxSchemaVersion: release.maxSchemaVersion,
      nodeVersion: runtime.nodeVersion,
    },
    null,
    2,
  ),
);
console.log(`Wrote installer checksum manifest: ${artifact}.json`);
