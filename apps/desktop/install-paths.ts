import { existsSync } from 'node:fs';
import path from 'node:path';

/** Development and installed launches share Host artifacts; only the runtime and default workspace differ. */
export function desktopPaths(options: {
  packaged: boolean;
  resourcesPath: string;
  mainDirectory: string;
  userData: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  platform?: NodeJS.Platform;
}): { nodePath: string; hostPath: string; workspace: string } {
  const nodePath = options.packaged
    ? path.join(
        options.resourcesPath,
        'runtime',
        (options.platform ?? process.platform) === 'win32' ? 'node.exe' : 'node',
      )
    : options.env.YUANTU_NODE_PATH;
  if (!nodePath || !path.isAbsolute(nodePath))
    throw new Error(
      'Start the development desktop through scripts/start-desktop.mjs with an absolute Node path',
    );
  const argument = options.args
    .find((arg) => arg.startsWith('--workspace='))
    ?.slice('--workspace='.length);
  const workspace = path.resolve(
    argument ||
      options.env.YUANTU_WORKSPACE ||
      (options.packaged ? path.join(options.userData, 'workspace') : options.cwd),
  );
  /**
   * The single-file Host the build produces, and the compiled entry as its fallback.
   *
   * `npm run build` writes the bundle beside the compiled tools (so every worker and asset path the Host resolves
   * relative to its own module stays true); the desktop prefers it because one file is parsed rather than a module
   * graph resolved across `node_modules` on every launch. `main.js` remains for a checkout that only ran `tsc`, so a
   * partial build still starts instead of pointing at a file that is not there.
   */
  const bundled = path.resolve(options.mainDirectory, '../packages/tools/host.bundle.js');
  const compiled = path.resolve(options.mainDirectory, '../apps/agent-host/main.js');
  return {
    nodePath,
    hostPath: existsSync(bundled) ? bundled : compiled,
    workspace,
  };
}
