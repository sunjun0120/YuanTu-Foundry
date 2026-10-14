import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolEnvironment } from '../packages/tools/environment.ts';
import { appContainerRuntimeError } from '../packages/tools/appcontainer-runtime.ts';

export async function inspectWindowsRuntime(executable, source = process.env) {
  const env = toolEnvironment(source);
  delete env.LD_LIBRARY_PATH;
  delete env.DYLD_LIBRARY_PATH;
  const { stdout } = await promisify(execFile)(
    executable,
    [
      '-p',
      'JSON.stringify({nodeVersion:process.versions.node,uv:process.versions.uv,platform:process.platform,arch:process.arch,electron:process.versions.electron})',
    ],
    { env, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
  );
  const info = JSON.parse(stdout.trim());
  if (!info || typeof info !== 'object' || typeof info.nodeVersion !== 'string')
    throw new Error('Invalid standalone Node runtime identity');
  return info;
}

export function assertWindowsRuntime(info, { enhanced = false } = {}) {
  if (
    info.platform !== 'win32' ||
    info.arch !== 'x64' ||
    info.electron ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.nodeVersion ?? '') ||
    Number(info.nodeVersion.split('.')[0]) < 24
  )
    throw new Error('Windows x64 packaging requires standalone Windows x64 Node.js >=24');
  if (enhanced) {
    const reason = appContainerRuntimeError(info.uv);
    if (reason) throw new Error(reason);
  }
}
