/**
 * The desktop main process's project-workspace rules: canonical directories, the first launch and the safe default.
 *
 * The registry store owns the list; this layer decides which directory a path really is, refuses the application's
 * own install tree and picks the workspace the Host starts in. It has no Electron dependency so the startup rules can
 * be tested against temporary directories.
 */
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectWorkspacesFile } from './project-workspaces-contract.ts';
import { ProjectWorkspacesStore } from './project-workspaces-store.ts';

function insidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function samePath(a: string, b: string): boolean {
  const normalized = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  return normalized(path.resolve(a)) === normalized(path.resolve(b));
}

/**
 * The real directory behind `input`, or a refusal.
 *
 * `installDirectory` is the packaged application tree; a workspace inside it would be deleted by uninstall/upgrade
 * and would make `prepareUpgrade`'s app/data overlap check refuse every update.
 */
export function canonicalWorkspace(
  input: string,
  options: { installDirectory?: string; create?: boolean },
): string {
  const resolved = path.resolve(input);
  if (options.create) mkdirSync(resolved, { recursive: true });
  const real = realpathSync(resolved);
  if (!statSync(real).isDirectory()) throw new Error('Workspace must be a directory');
  if (options.installDirectory) {
    const install = realpathSync(options.installDirectory);
    if (insidePath(real, install))
      throw new Error('Workspace must not be inside the application directory');
  }
  return real;
}

export interface StartupWorkspace {
  workspace: string;
  registry: ProjectWorkspacesFile;
}

/**
 * The workspace this launch starts in.
 *
 * Explicit `--workspace` wins and is registered. Otherwise an initialized registry restores its active entry, or the
 * first still-available entry; an initialized empty registry keeps its empty state and the Host uses the fallback
 * without adding it. A truly new install registers the fallback exactly once.
 */
export async function resolveStartupWorkspace(
  store: ProjectWorkspacesStore,
  options: {
    explicitPath?: string;
    fallbackPath: string;
    installDirectory?: string;
  },
): Promise<StartupWorkspace> {
  if (options.explicitPath) {
    const explicit = canonicalWorkspace(options.explicitPath, {
      installDirectory: options.installDirectory,
    });
    const registry = (await store.snapshot()).initialized
      ? await store.add(explicit)
      : await store.initialize(explicit);
    return { workspace: explicit, registry };
  }

  let registry = await store.snapshot();
  if (registry.initialized) {
    const active = registry.workspaces.find(
      (entry) => entry.id === registry.activeWorkspaceId && !entry.removed,
    );
    for (const candidate of active ? [active] : []) {
      try {
        const workspace = canonicalWorkspace(candidate.canonicalPath, {
          installDirectory: options.installDirectory,
        });
        return { workspace, registry };
      } catch {
        /* The active folder is unavailable; fall through to the next one. */
      }
    }
    for (const candidate of registry.workspaces.filter((entry) => !entry.removed)) {
      try {
        const workspace = canonicalWorkspace(candidate.canonicalPath, {
          installDirectory: options.installDirectory,
        });
        registry = await store.select(candidate.id);
        return { workspace, registry };
      } catch {
        /* A missing drive stays listed; this launch needs a directory that exists now. */
      }
    }
    // An initialized empty (or wholly unavailable) list is a valid state: do not register the fallback again.
    const fallback = canonicalWorkspace(options.fallbackPath, {
      installDirectory: options.installDirectory,
      create: true,
    });
    return { workspace: fallback, registry };
  }

  const fallback = canonicalWorkspace(options.fallbackPath, {
    installDirectory: options.installDirectory,
    create: true,
  });
  registry = await store.initialize(fallback);
  return { workspace: fallback, registry };
}

/** The registry operations the IPC layer needs, all canonicalized before they touch the file. */
export class ProjectWorkspaces {
  private readonly store: ProjectWorkspacesStore;
  private readonly installDirectory: string | undefined;

  constructor(store: ProjectWorkspacesStore, installDirectory?: string) {
    this.store = store;
    this.installDirectory = installDirectory;
  }

  list(): Promise<ProjectWorkspacesFile> {
    return this.store.snapshot();
  }

  async add(input: string, displayName?: string, select = true): Promise<ProjectWorkspacesFile> {
    const canonical = canonicalWorkspace(input, { installDirectory: this.installDirectory });
    return this.store.add(canonical, displayName, select);
  }

  select(id: string): Promise<ProjectWorkspacesFile> {
    return this.store.select(id);
  }

  rename(id: string, displayName: string): Promise<ProjectWorkspacesFile> {
    return this.store.rename(id, displayName);
  }

  remove(id: string): Promise<ProjectWorkspacesFile> {
    return this.store.remove(id);
  }

  setCollapsed(id: string, collapsed: boolean): Promise<ProjectWorkspacesFile> {
    return this.store.setCollapsed(id, collapsed);
  }
  setProjectsCollapsed(collapsed: boolean): Promise<ProjectWorkspacesFile> {
    return this.store.setProjectsCollapsed(collapsed);
  }

  setLastSession(id: string, sessionId: string | null): Promise<ProjectWorkspacesFile> {
    return this.store.setLastSession(id, sessionId);
  }
}
