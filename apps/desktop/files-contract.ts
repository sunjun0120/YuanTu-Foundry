import type { WorkspaceListing, WorkspacePreview } from '../../packages/protocol/rpc.ts';

/**
 * What the renderer may ask about the workspace's files, and how the answer comes back.
 *
 * The vocabulary is an intent (`browse this directory`, `show this file`), not a shell command, and every
 * answer is a value the Host produced — this channel never reads the filesystem itself. That is the whole
 * point of it: the containment rule that decides which paths exist lives next to the file tools, in the
 * process that owns the workspace, and an Electron-side reader would be a second copy of a security decision.
 *
 * The shapes below are the protocol's own (`WorkspaceListing`/`WorkspacePreview`) rather than a
 * shell-flavoured restatement, so a field added for the Host is visible to the window without a third
 * definition to keep in step.
 */
export type FilesCommand =
  /** The children of one directory; the workspace root when no path is given. */
  | { type: 'list'; path?: string }
  /** One file, as text, as an image, or as an honest "unsupported". */
  | { type: 'read'; path: string };

export type FilesReply =
  | { ok: true; listing: WorkspaceListing }
  | { ok: true; preview: WorkspacePreview }
  | { ok: false; error: string };

/**
 * The longest path this channel accepts.
 *
 * A bound rather than a rule: the Windows maximum for a path is 32767 characters and the shape of a path is
 * the Host's business. Checking only the shape here is deliberate — a second opinion about which paths are
 * legal is how two layers come to disagree about `..`.
 */
const MAX_PATH_CHARS = 4096;

export function parseFilesCommand(input: unknown): FilesCommand {
  const fail = () => {
    throw new Error('Invalid workspace file request');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  const fields: Record<string, string[]> = { list: ['type', 'path'], read: ['type', 'path'] };
  if (
    typeof value.type !== 'string' ||
    !Object.hasOwn(fields, value.type) ||
    Object.keys(value).some((key) => !fields[value.type as string]!.includes(key))
  )
    return fail();
  const path = value.path;
  if (path !== undefined) {
    if (
      typeof path !== 'string' ||
      path.length > MAX_PATH_CHARS ||
      path.includes('\0') ||
      (value.type === 'read' && !path.trim())
    )
      return fail();
    return { type: value.type as 'list' | 'read', path };
  }
  if (value.type === 'read') return fail();
  return { type: 'list' };
}
