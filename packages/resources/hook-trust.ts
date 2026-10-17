import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { userStateDirectory } from '../platform/user-state.ts';
import type { HookDeclaration } from './hook-config.ts';
/**
 * Per-workspace trust for the external hook bridge.
 *
 * A hook declaration is a command line committed to somebody else's repository, so opening a clone and
 * sending one message must not be enough to run it. The bridge therefore installs a workspace's hooks only
 * when the operator has trusted *exactly these* declarations: the record holds a digest of every file, event,
 * matcher, command and referenced workspace file, and any change to any of them is a different digest that
 * has to be confirmed again.
 *
 * The record lives in the user's state directory and never in the workspace. A trust decision stored next to
 * the thing it vouches for could be committed, cloned or written by the agent that the hooks are policing,
 * which would make it a second copy of the declarations rather than a decision about them.
 */
export const HOOK_TRUST_FILE_NAME = 'hook-trust.json';
/** Bounded: a record is one line per workspace, and nobody trusts this many. */
const MAX_TRUSTED_WORKSPACES = 1_000;
const MAX_HOOK_FILE_BYTES = 4 * 1024 * 1024;
interface TrustRecord {
  digest: string;
  trustedAt: string;
}
interface TrustDocument {
  version: 1;
  workspaces: Record<string, TrustRecord>;
}
/** Where trust records are kept: `<user state>/hook-trust.json`. */
export function hookTrustFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userStateDirectory(env), HOOK_TRUST_FILE_NAME);
}
/**
 * The digest a trust record vouches for.
 *
 * Order is part of it, because order is part of the behaviour: the first hook to block wins. The timeout is
 * not, because it changes how long a command may run, not which command runs. Simple shell-like tokenization
 * preserves quoted paths and Windows separators; this is not a shell interpreter and does not follow imports
 * or expand variables. Existing regular files inside the workspace contribute their full content hashes in
 * token order. Unreadable files and files over 4 MiB refuse trust rather than vouching for a partial script.
 */
export function hookDeclarationsDigest(
  workspace: string,
  declarations: readonly HookDeclaration[],
): string {
  const canonical = declarations.map((entry) => [
    entry.file,
    entry.event,
    entry.matcher ?? null,
    entry.command,
    referencedFilesDigest(workspace, entry.command),
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function referencedFilesDigest(workspace: string, command: string): string[] {
  const hashes: string[] = [];
  for (const token of command.match(/(?:[^\s"'|&;<>()]+|"[^"]*"|'[^']*')+/g) ?? []) {
    const unquoted = token.replace(
      /"([^"]*)"|'([^']*)'/g,
      (_match, double, single) => double ?? single,
    );
    const file = path.resolve(workspace, unquoted);
    if (!isInside(workspace, file)) continue;
    let metadata;
    try {
      metadata = statSync(file);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (!metadata.isFile() || !isInside(workspace, realpathSync.native(file))) continue;
    if (metadata.size > MAX_HOOK_FILE_BYTES)
      throw new Error(`Hook reference exceeds 4 MiB: ${file}`);
    const content = readFileSync(file);
    if (content.byteLength > MAX_HOOK_FILE_BYTES)
      throw new Error(`Hook reference exceeds 4 MiB: ${file}`);
    hashes.push(createHash('sha256').update(content).digest('hex'));
  }
  return hashes;
}
/** One spelling per directory, so a trust record is not lost to a drive-letter case or a symlink. */
function workspaceKey(workspace: string): string {
  let resolved = path.resolve(workspace);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // A directory that cannot be resolved still gets a stable key; it simply will not match a real one.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/** True when `file` is the workspace itself or anything under it. */
function isInside(workspace: string, file: string): boolean {
  const relative = path.relative(workspaceKey(workspace), workspaceKey(path.dirname(file)));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}
function readDocument(file: string): TrustDocument {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} };
    throw error;
  }
  const value = JSON.parse(text) as Partial<TrustDocument>;
  if (
    !value ||
    value.version !== 1 ||
    !value.workspaces ||
    typeof value.workspaces !== 'object' ||
    Array.isArray(value.workspaces)
  )
    throw new Error(`Invalid hook trust file ${file}`);
  return { version: 1, workspaces: value.workspaces };
}
export type HookTrustState =
  | { trusted: true }
  | { trusted: false; reason: 'untrusted' | 'changed' | 'unavailable'; detail?: string };
/**
 * Whether the operator trusted exactly these declarations for this workspace.
 *
 * Every failure answers "not trusted": an unreadable record, a record inside the workspace, or one that
 * names a different digest. Failing closed is the whole point of the gate.
 */
export function workspaceHookTrust(
  workspace: string,
  declarations: readonly HookDeclaration[],
  file: string,
): HookTrustState {
  if (isInside(workspace, file))
    return {
      trusted: false,
      reason: 'unavailable',
      detail: `the trust file ${file} is inside the workspace; set YUANTU_STATE_DIR outside it`,
    };
  let document: TrustDocument;
  let digest: string;
  try {
    document = readDocument(file);
    digest = hookDeclarationsDigest(workspace, declarations);
  } catch (error) {
    return {
      trusted: false,
      reason: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const record = document.workspaces[workspaceKey(workspace)];
  if (!record) return { trusted: false, reason: 'untrusted' };
  return record.digest === digest ? { trusted: true } : { trusted: false, reason: 'changed' };
}
/**
 * Records that the operator trusts exactly these declarations for this workspace.
 *
 * Written to a sibling file and renamed into place, so a crash cannot leave a half-written record that
 * the next read would refuse — and with it every other workspace's trust.
 */
export function trustWorkspaceHooks(
  workspace: string,
  declarations: readonly HookDeclaration[],
  file: string,
  now: Date = new Date(),
): void {
  if (isInside(workspace, file))
    throw new Error(
      `Refusing to store hook trust inside the workspace (${file}); set YUANTU_STATE_DIR outside it`,
    );
  const document = readDocument(file);
  const key = workspaceKey(workspace);
  delete document.workspaces[key];
  const kept = Object.entries(document.workspaces).slice(-(MAX_TRUSTED_WORKSPACES - 1));
  document.workspaces = Object.fromEntries(kept);
  document.workspaces[key] = {
    digest: hookDeclarationsDigest(workspace, declarations),
    trustedAt: now.toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
/** A human-readable list of what would run, for a confirmation prompt or an operator notice. */
export function describeHookDeclarations(declarations: readonly HookDeclaration[]): string {
  return declarations
    .map(
      (entry) =>
        `[${entry.file}] ${entry.event}${entry.matcher === undefined ? '' : ` (${entry.matcher})`}\n  ${entry.command}`,
    )
    .join('\n');
}
