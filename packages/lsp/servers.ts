import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { toolEnvironment } from '../tools/environment.ts';

export interface LspServerDefinition {
  language: string;
  command: string;
  args: string[];
  extensions: string[];
  env?: Record<string, string>;
  install?: string;
  /** Startup cost shown before approval, for servers that index heavily. */
  notes?: string;
  /**
   * npm package that provides `command`. When it is installed in the workspace,
   * its real JS entry is run through `node` instead of npm's `.bin` shim: those
   * shims are `.cmd` files on Windows, which cannot be spawned without a shell.
   */
  package?: string;
}

export interface ResolvedServerCommand {
  command: string;
  args: string[];
  /** Where it was found, for the approval description. */
  via: string;
}

const INSTALL_HINT = (pkg: string) => `npm install -D ${pkg}`;

/** A small built-in catalog so a common project needs no configuration at all. */
export const BUILT_IN_SERVERS: readonly LspServerDefinition[] = [
  {
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    install: INSTALL_HINT('typescript-language-server typescript'),
    notes: 'Needs the project to have the "typescript" package resolvable.',
    package: 'typescript-language-server',
  },
  {
    language: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    install: INSTALL_HINT('pyright'),
    notes: 'Indexes the interpreter environment on first use.',
    package: 'pyright',
  },
  {
    language: 'go',
    command: 'gopls',
    args: [],
    extensions: ['.go'],
    install: 'go install golang.org/x/tools/gopls@latest',
    notes:
      'Indexes the whole module on first use; can take tens of seconds and several hundred MB.',
  },
  {
    language: 'rust',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    install: 'rustup component add rust-analyzer',
    notes:
      'Runs "cargo metadata" and indexes dependencies on first use; can take minutes and over 1GB on a large crate.',
  },
];

interface ServerOverride {
  command?: string;
  args?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  install?: string;
  notes?: string;
  package?: string;
  disabled?: boolean;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${field} must be an array of strings`);
  return value.map((item) => String(item));
}
function validate(definition: LspServerDefinition): LspServerDefinition {
  if (!definition.command.trim() || definition.command.includes('\0'))
    throw new Error('command must be a non-empty string');
  if (definition.command.length > 1024) throw new Error('command is too long');
  if (definition.args.some((arg) => arg.includes('\0')))
    throw new Error('args must not contain NUL');
  if (!definition.extensions.length) throw new Error('extensions must not be empty');
  for (const extension of definition.extensions)
    if (!extension.startsWith('.') || extension.length < 2 || extension.includes('/'))
      throw new Error(`invalid extension: ${extension}`);
  return definition;
}

/**
 * Built-in catalog merged with an optional `.yuantu/lsp.json`. Only explicitly
 * declared commands are ever run; nothing is downloaded automatically.
 */
export async function resolveServers(
  root: string,
): Promise<{ servers: LspServerDefinition[]; problems: string[] }> {
  const servers = new Map<string, LspServerDefinition>(
    BUILT_IN_SERVERS.map((server) => [server.language, { ...server }]),
  );
  const problems: string[] = [];
  let raw: string | undefined;
  try {
    raw = await readFile(path.join(root, '.yuantu', 'lsp.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      problems.push(`.yuantu/lsp.json could not be read: ${String(error)}`);
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push('.yuantu/lsp.json is not valid JSON; the built-in catalog is used');
    }
    if (parsed !== undefined && parsed !== null) {
      const overrides = (parsed as { servers?: unknown }).servers;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
        problems.push('.yuantu/lsp.json must contain a "servers" object');
      else
        for (const [language, value] of Object.entries(overrides as Record<string, unknown>)) {
          try {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('entry must be an object');
            const override = value as ServerOverride;
            if (override.disabled === true) {
              servers.delete(language);
              continue;
            }
            const base = servers.get(language);
            servers.set(
              language,
              validate({
                language,
                command: String(override.command ?? base?.command ?? ''),
                args: stringList(override.args, 'args') ?? base?.args ?? [],
                extensions: stringList(override.extensions, 'extensions') ?? base?.extensions ?? [],
                ...(override.env && typeof override.env === 'object' && !Array.isArray(override.env)
                  ? { env: override.env as Record<string, string> }
                  : base?.env
                    ? { env: base.env }
                    : {}),
                ...((override.install ?? base?.install)
                  ? { install: String(override.install ?? base?.install) }
                  : {}),
                ...((override.notes ?? base?.notes)
                  ? { notes: String(override.notes ?? base?.notes) }
                  : {}),
                ...((override.package ?? base?.package)
                  ? { package: String(override.package ?? base?.package) }
                  : {}),
              }),
            );
          } catch (error) {
            problems.push(
              `.yuantu/lsp.json server "${language}" was ignored: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
    }
  }
  return { servers: [...servers.values()], problems };
}

/** Longest matching extension wins, so `.d.ts` beats `.ts`. */
export function languageForFile(
  file: string,
  servers: readonly LspServerDefinition[],
): LspServerDefinition | undefined {
  const lower = file.toLowerCase();
  let best: LspServerDefinition | undefined;
  let bestLength = -1;
  for (const server of servers)
    for (const extension of server.extensions)
      if (lower.endsWith(extension) && extension.length > bestLength) {
        best = server;
        bestLength = extension.length;
      }
  return best;
}

/**
 * Whether `spawn(..., { shell: false })` can execute this file on this platform.
 * On Windows npm installs `.cmd`/`.bat`/`.ps1` shims plus an extensionless POSIX
 * shell script; none of those can be spawned without a shell, which this project
 * deliberately avoids. Only real executables qualify.
 */
function spawnable(file: string): boolean {
  if (process.platform !== 'win32') return true;
  const extension = path.extname(file).toLowerCase();
  return extension === '.exe' || extension === '.com';
}

/**
 * Resolve a command without spawning it, so failures can name the install step.
 * The workspace's own `node_modules/.bin` is searched before PATH, so a project
 * that declares its server as a devDependency needs no global install and a
 * local pin wins over a global one. Only directly spawnable files are accepted,
 * so a Windows `.cmd` shim is skipped rather than returned and then failing with
 * a confusing ENOENT at spawn time.
 */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = toolEnvironment(),
  root?: string,
): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const candidates: string[] = [];
  if (command.includes('/') || command.includes('\\')) candidates.push(command);
  else {
    const directories = [
      ...(root ? [path.join(root, 'node_modules', '.bin')] : []),
      ...(env.PATH ?? env.Path ?? '').split(path.delimiter),
    ];
    for (const directory of directories) {
      if (!directory) continue;
      for (const extension of extensions)
        candidates.push(path.join(directory, command + extension));
    }
  }
  for (const candidate of candidates) {
    if (!spawnable(candidate)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Run a workspace-local npm package's real entry through `node`. This is the
 * only shell-free way to use a devDependency-installed server on Windows, and it
 * pins the version the project actually declared.
 */
async function localPackageEntry(
  root: string,
  definition: LspServerDefinition,
): Promise<string | undefined> {
  if (!definition.package) return undefined;
  try {
    const directory = path.join(root, 'node_modules', definition.package);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
      bin?: unknown;
    };
    const bin = manifest.bin;
    const entry =
      typeof bin === 'string'
        ? bin
        : bin && typeof bin === 'object' && !Array.isArray(bin)
          ? ((bin as Record<string, unknown>)[definition.command] ??
            Object.values(bin as Record<string, unknown>)[0])
          : undefined;
    if (typeof entry !== 'string' || !entry) return undefined;
    const file = path.resolve(directory, entry);
    // A bin entry must stay inside its own package.
    if (path.relative(directory, file).startsWith('..')) return undefined;
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Decide the exact command and argv for a server, or undefined when unavailable. */
export async function resolveServerCommand(
  root: string,
  definition: LspServerDefinition,
): Promise<ResolvedServerCommand | undefined> {
  const entry = await localPackageEntry(root, definition);
  if (entry)
    return {
      command: process.execPath,
      args: [entry, ...definition.args],
      via: `node_modules/${definition.package}`,
    };
  const found = await findExecutable(definition.command, undefined, root);
  if (!found) return undefined;
  return {
    command: found,
    args: definition.args,
    via: found.includes(`${path.sep}node_modules${path.sep}`) ? 'node_modules/.bin' : 'PATH',
  };
}
