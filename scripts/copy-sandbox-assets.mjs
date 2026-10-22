import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('..', import.meta.url));
const destination = path.join(project, 'dist/packages/tools/windows-sandbox');
await mkdir(destination, { recursive: true });
await copyFile(
  path.join(project, 'packages/tools/windows-sandbox/acl.ps1'),
  path.join(destination, 'acl.ps1'),
);
// The executor ships when it was built. `npm run build` may run before a helper exists; packaging builds the
// helper first and verifies the packaged copy in `check-windows-package.mjs`.
await copyFile(
  path.join(project, 'packages/tools/windows-sandbox/yuantu-sandbox.exe'),
  path.join(destination, 'yuantu-sandbox.exe'),
).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
