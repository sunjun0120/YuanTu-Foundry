import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HookRegistry, type ExtensionHooks } from '../../packages/tools/hooks.ts';

/**
 * Load a trusted hooks module that a human named explicitly.
 *
 * Hooks are JavaScript and cannot be sandboxed, so they are deliberately never discovered inside the
 * workspace. That is the same rule the extension loader follows (`packages/resources/extensions.ts`):
 * project files are never imported as code. A hooks module runs only when an operator passes
 * `--hooks` or sets `YUANTU_HOOKS_MODULE`, and a module that resolves inside the workspace is
 * refused outright — otherwise cloning a repository would be enough to run its code, because a
 * wrapper script or launcher could point the flag at a path the repository itself controls.
 *
 * The module may export `hooks` or a default export, as an `ExtensionHooks` object or as a function
 * (sync or async) returning one, which lets a module build state before its hooks are used.
 */
export async function loadHookRegistry(
  spec: string | undefined,
  workspace?: string,
): Promise<HookRegistry> {
  const registry = new HookRegistry();
  if (!spec || !spec.trim()) return registry;
  const target = path.resolve(spec);
  if (workspace) {
    const root = path.resolve(workspace);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      throw new Error(
        `Hooks module ${spec} is inside the workspace; hooks are trusted code and must live outside it`,
      );
  }
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(target).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Cannot load hooks module ${spec}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const exported = module.hooks ?? module.default;
  if (exported === undefined)
    throw new Error(`Hooks module ${spec} must export "hooks" or a default export`);
  const value = typeof exported === 'function' ? await exported() : exported;
  registry.register(value as ExtensionHooks);
  return registry;
}
