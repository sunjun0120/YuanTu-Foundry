/**
 * The desktop's project-workspace registry: the list behind the left sidebar.
 *
 * This is not the sub-agent workspace store. It names the local folders a person added, the display name they chose,
 * which one is active and which session was last open. The session database still belongs to the folder; removing an
 * entry never moves or deletes it.
 */
export const PROJECT_WORKSPACES_SCHEMA = 1;
export const MAX_DISPLAY_NAME = 80;

export interface ProjectWorkspace {
  id: string;
  canonicalPath: string;
  displayName: string;
  collapsed: boolean;
  lastSessionId: string | null;
  order: number;
  removed: boolean;
}

export interface ProjectWorkspacesFile {
  schemaVersion: number;
  initialized: boolean;
  activeWorkspaceId: string | null;
  workspaces: ProjectWorkspace[];
}

export class ProjectWorkspacesError extends Error {
  readonly code: 'invalid' | 'future' | 'name' | 'missing' | 'duplicate' | 'active';
  constructor(code: ProjectWorkspacesError['code'], message: string) {
    super(message);
    this.name = 'ProjectWorkspacesError';
    this.code = code;
  }
}

export type ProjectWorkspaceCommand =
  | { type: 'list' }
  | { type: 'add'; path?: string }
  | { type: 'select'; id: string }
  | { type: 'rename'; id: string; displayName: string }
  | { type: 'remove'; id: string }
  | { type: 'collapse'; id: string; collapsed: boolean }
  | { type: 'lastSession'; id: string; sessionId: string | null };

export interface ProjectRuntimeView {
  ready: boolean;
  running: boolean;
  waiting: number;
  sessions: { id: string; title: string; running: boolean; waiting: number }[];
}

export type ProjectWorkspaceReply =
  | {
      ok: true;
      registry: ProjectWorkspacesFile;
      runtime?: Record<string, ProjectRuntimeView>;
      cancelled?: boolean;
    }
  | { ok: false; error: string };

export function parseProjectWorkspaceCommand(input: unknown): ProjectWorkspaceCommand {
  if (!record(input) || typeof input.type !== 'string') throw new Error('Invalid project command');
  const type = input.type;
  if (type === 'list') return { type };
  if (type === 'add') {
    if (input.path !== undefined && typeof input.path !== 'string')
      throw new Error('Invalid workspace path');
    return { type, ...(input.path ? { path: input.path } : {}) };
  }
  if (typeof input.id !== 'string' || !/^[\w-]{1,128}$/u.test(input.id))
    throw new Error('Invalid workspace id');
  switch (type) {
    case 'select':
    case 'remove':
      return { type, id: input.id };
    case 'rename':
      if (typeof input.displayName !== 'string') throw new Error('Invalid workspace name');
      return { type, id: input.id, displayName: input.displayName };
    case 'collapse':
      if (typeof input.collapsed !== 'boolean') throw new Error('Invalid collapse state');
      return { type, id: input.id, collapsed: input.collapsed };
    case 'lastSession':
      if (input.sessionId !== null && typeof input.sessionId !== 'string')
        throw new Error('Invalid session id');
      return { type, id: input.id, sessionId: input.sessionId };
    default:
      throw new Error('Unknown project command');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyProjectWorkspaces(): ProjectWorkspacesFile {
  return {
    schemaVersion: PROJECT_WORKSPACES_SCHEMA,
    initialized: false,
    activeWorkspaceId: null,
    workspaces: [],
  };
}

/** Validate a registry file before it replaces anything; a future schema is refused, not guessed. */
export function parseProjectWorkspaces(value: unknown): ProjectWorkspacesFile {
  if (!record(value))
    throw new ProjectWorkspacesError('invalid', 'Workspace registry is not an object');
  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion))
    throw new ProjectWorkspacesError('invalid', 'Workspace registry schema is invalid');
  if (value.schemaVersion > PROJECT_WORKSPACES_SCHEMA)
    throw new ProjectWorkspacesError(
      'future',
      `Workspace registry schema v${value.schemaVersion} is newer than this build`,
    );
  if (value.schemaVersion !== PROJECT_WORKSPACES_SCHEMA)
    throw new ProjectWorkspacesError('invalid', 'Workspace registry schema is not supported');
  if (typeof value.initialized !== 'boolean')
    throw new ProjectWorkspacesError(
      'invalid',
      'Workspace registry initialization flag is invalid',
    );
  if (value.activeWorkspaceId !== null && typeof value.activeWorkspaceId !== 'string')
    throw new ProjectWorkspacesError('invalid', 'Workspace registry active id is invalid');
  if (!Array.isArray(value.workspaces))
    throw new ProjectWorkspacesError('invalid', 'Workspace registry list is invalid');
  const seen = new Set<string>();
  const workspaces: ProjectWorkspace[] = value.workspaces.map((entry) => {
    if (
      !record(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.canonicalPath !== 'string' ||
      typeof entry.displayName !== 'string' ||
      typeof entry.collapsed !== 'boolean' ||
      (entry.lastSessionId !== null && typeof entry.lastSessionId !== 'string') ||
      typeof entry.order !== 'number' ||
      !Number.isInteger(entry.order) ||
      typeof entry.removed !== 'boolean'
    )
      throw new ProjectWorkspacesError('invalid', 'Workspace registry entry is invalid');
    if (seen.has(entry.id))
      throw new ProjectWorkspacesError('invalid', 'Workspace registry has duplicate ids');
    seen.add(entry.id);
    if (!entry.displayName.trim() || entry.displayName.length > MAX_DISPLAY_NAME)
      throw new ProjectWorkspacesError('invalid', 'Workspace registry display name is invalid');
    return {
      id: entry.id,
      canonicalPath: entry.canonicalPath,
      displayName: entry.displayName,
      collapsed: entry.collapsed,
      lastSessionId: entry.lastSessionId,
      order: entry.order,
      removed: entry.removed,
    };
  });
  if (
    value.activeWorkspaceId !== null &&
    !workspaces.some((entry) => entry.id === value.activeWorkspaceId && !entry.removed)
  )
    throw new ProjectWorkspacesError('invalid', 'Workspace registry active id is missing');
  return {
    schemaVersion: value.schemaVersion,
    initialized: value.initialized,
    activeWorkspaceId: value.activeWorkspaceId,
    workspaces,
  };
}

export function normalizeDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_DISPLAY_NAME || /[\x00-\x1f\x7f]/u.test(name))
    throw new ProjectWorkspacesError('name', 'Workspace display name is invalid');
  return name;
}

/** Same folder on this platform: Windows paths compare case-insensitively; the caller passes realpaths. */
export function sameWorkspacePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A readable default for a canonical path, including a drive root (`C:\` → `C:`). */
export function defaultWorkspaceName(canonicalPath: string): string {
  const trimmed = canonicalPath.replace(/[\\/]+$/u, '');
  const name = trimmed.split(/[\\/]/u).pop();
  return name || trimmed || canonicalPath;
}
