/**
 * The project-workspace registry file in userData.
 *
 * Every write is serialized and replaces the file atomically; a corrupt or newer file is never overwritten with a
 * default list. The store owns the list and the active id only — canonicalizing a folder, refusing the install
 * directory and starting a Host stay in the desktop main process.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../../packages/platform/write-all.ts';
import {
  defaultWorkspaceName,
  emptyProjectWorkspaces,
  normalizeDisplayName,
  parseProjectWorkspaces,
  ProjectWorkspacesError,
  sameWorkspacePath,
  type ProjectWorkspace,
  type ProjectWorkspacesFile,
} from './project-workspaces-contract.ts';

function clone(state: ProjectWorkspacesFile): ProjectWorkspacesFile {
  return structuredClone(state);
}

function nextOrder(state: ProjectWorkspacesFile): number {
  return state.workspaces.reduce((max, entry) => Math.max(max, entry.order), -1) + 1;
}

function visible(state: ProjectWorkspacesFile): ProjectWorkspace[] {
  return state.workspaces
    .filter((entry) => !entry.removed)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export class ProjectWorkspacesStore {
  private readonly file: string;
  private state: ProjectWorkspacesFile = emptyProjectWorkspaces();
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  private operation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(action, action);
    this.tail = run.catch(() => {});
    return run;
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyProjectWorkspaces();
        this.loaded = true;
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProjectWorkspacesError('invalid', 'Workspace registry is not valid JSON');
    }
    this.state = parseProjectWorkspaces(parsed);
    this.loaded = true;
  }

  private async persist(next: ProjectWorkspacesFile): Promise<ProjectWorkspacesFile> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
    this.state = next;
    return clone(next);
  }

  /** The current registry, loading it once. */
  snapshot(): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      return clone(this.state);
    });
  }

  /** First launch: register the path chosen by the startup rules once; later calls do not overwrite the list. */
  initialize(canonicalPath: string): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      if (this.state.initialized) return clone(this.state);
      const next = clone(this.state);
      next.initialized = true;
      const entry = this.createEntry(next, canonicalPath, undefined);
      next.activeWorkspaceId = entry.id;
      return this.persist(next);
    });
  }

  add(canonicalPath: string, displayName?: string, select = true): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const existing = next.workspaces.find((entry) =>
        sameWorkspacePath(entry.canonicalPath, canonicalPath),
      );
      if (existing) {
        if (existing.removed) existing.removed = false;
        if (displayName !== undefined) existing.displayName = normalizeDisplayName(displayName);
        next.initialized = true;
        if (select) next.activeWorkspaceId = existing.id;
        return this.persist(next);
      }
      const entry = this.createEntry(next, canonicalPath, displayName);
      next.initialized = true;
      if (select) next.activeWorkspaceId = entry.id;
      return this.persist(next);
    });
  }

  select(id: string): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const entry = next.workspaces.find((candidate) => candidate.id === id && !candidate.removed);
      if (!entry) throw new ProjectWorkspacesError('missing', 'Workspace is not in the list');
      next.activeWorkspaceId = entry.id;
      return this.persist(next);
    });
  }

  rename(id: string, displayName: string): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const entry = next.workspaces.find((candidate) => candidate.id === id);
      if (!entry) throw new ProjectWorkspacesError('missing', 'Workspace is not in the list');
      entry.displayName = normalizeDisplayName(displayName);
      return this.persist(next);
    });
  }

  remove(id: string): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const entry = next.workspaces.find((candidate) => candidate.id === id && !candidate.removed);
      if (!entry) throw new ProjectWorkspacesError('missing', 'Workspace is not in the list');
      entry.removed = true;
      if (next.activeWorkspaceId === id) {
        const remaining = visible(next);
        next.activeWorkspaceId = remaining[0]?.id ?? null;
      }
      return this.persist(next);
    });
  }

  setCollapsed(id: string, collapsed: boolean): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const entry = next.workspaces.find((candidate) => candidate.id === id);
      if (!entry) throw new ProjectWorkspacesError('missing', 'Workspace is not in the list');
      entry.collapsed = collapsed;
      return this.persist(next);
    });
  }

  setProjectsCollapsed(collapsed: boolean): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      return this.persist({ ...clone(this.state), projectsCollapsed: collapsed });
    });
  }

  setLastSession(id: string, sessionId: string | null): Promise<ProjectWorkspacesFile> {
    return this.operation(async () => {
      await this.ensure();
      const next = clone(this.state);
      const entry = next.workspaces.find((candidate) => candidate.id === id);
      if (!entry) throw new ProjectWorkspacesError('missing', 'Workspace is not in the list');
      entry.lastSessionId = sessionId;
      return this.persist(next);
    });
  }

  private createEntry(
    state: ProjectWorkspacesFile,
    canonicalPath: string,
    displayName: string | undefined,
  ): ProjectWorkspace {
    const entry: ProjectWorkspace = {
      id: randomUUID(),
      canonicalPath,
      displayName: displayName
        ? normalizeDisplayName(displayName)
        : defaultWorkspaceName(canonicalPath),
      collapsed: false,
      lastSessionId: null,
      order: nextOrder(state),
      removed: false,
    };
    state.workspaces.push(entry);
    return entry;
  }
}
