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
await copyFile(
  path.join(project, 'packages/tools/windows-sandbox/appcontainer-acl.ps1'),
  path.join(destination, 'appcontainer-acl.ps1'),
);
