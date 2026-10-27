import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * A development launch has no Runtime to borrow, so it has to name the Node that runs the Host.
 *
 * Its own class because the startup failure dialog needs the category, not the sentence: the recovery for this one
 * is a dictionary entry, while the detail below belongs in a log.
 */
export class MissingDevelopmentNode extends Error {
  constructor() {
    super(
      'The development desktop found no Node to run the Agent Host: set YUANTU_NODE_PATH to an absolute executable, start it through scripts/start-desktop.mjs, or keep node on PATH',
    );
    this.name = 'MissingDevelopmentNode';
  }
}

/**
 * The Node that runs the Host for a development launch, in the order such a launch can know it.
 *
 * `scripts/start-desktop.mjs` exports the Node it runs under as `YUANTU_NODE_PATH`, and that wins: a checkout may
 * deliberately run the Host on a different Node than the one on `PATH`. A launch that skipped the script still has
 * two ordinary answers — every npm script exports `npm_node_execpath` itself, and an IDE run or a bare
 * `electron dist/desktop/main.cjs` inherits the `PATH` the user starts Node with. Only a launch with none of the
 * three fails, and then the dialog names the fix rather than the variable.
 */
function developmentNode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const explicit = env.YUANTU_NODE_PATH;
  if (explicit) {
    // A relative path would resolve against Electron's cwd rather than the checkout's, so it is refused, not guessed.
    if (!path.isAbsolute(explicit)) throw new MissingDevelopmentNode();
    return explicit;
  }
  const npm = env.npm_node_execpath;
  if (npm && path.isAbsolute(npm) && existsSync(npm)) return npm;
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  for (const entry of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) {
    // A quoted entry is a PATH written by an installer; `path.join` handles the trailing separator.
    const directory = entry.replace(/^"|"$/gu, '');
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  throw new MissingDevelopmentNode();
}

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
  const platform = options.platform ?? process.platform;
  const nodePath = options.packaged
    ? path.join(options.resourcesPath, 'runtime', platform === 'win32' ? 'node.exe' : 'node')
    : developmentNode(platform, options.env);
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
