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
}): { nodePath: string; hostPath: string; workspace: string } {
  const nodePath = options.packaged
    ? path.join(options.resourcesPath, 'runtime', 'node.exe')
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
  return {
    nodePath,
    hostPath: path.resolve(options.mainDirectory, '../apps/agent-host/main.js'),
    workspace,
  };
}
