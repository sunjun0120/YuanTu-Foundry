import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PermissionPolicy } from '../../packages/core/permissions.ts';
import { permissionPolicyForMode, type PermissionMode } from './permission-settings.ts';

const defaultMode: PermissionMode = 'ask';

function modeFromPolicy(input: unknown): PermissionMode | undefined {
  try {
    new PermissionPolicy(input);
  } catch {
    return undefined;
  }
  const mode = (['read-only', 'ask', 'approve', 'full-access'] as const).find((mode) =>
    isDeepStrictEqual(input, permissionPolicyForMode(mode)),
  );
  if (mode) return mode;
  // Older versions called the write-allow policy “workspace”; preserve its behavior.
  if (
    isDeepStrictEqual(input, {
      version: 1,
      rules: [{ effect: 'allow', kind: 'write' }],
    })
  )
    return 'approve';
  return undefined;
}

export class PermissionSettingsStore {
  private mode: PermissionMode = defaultMode;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  get view(): PermissionMode {
    return this.mode;
  }

  /**
   * Read the chosen mode, and repair only what this store can actually tell is broken.
   *
   * The three outcomes used to be one `catch`, and all of them persisted a default:
   *
   * - **missing** is the first run: publish the default, because the Host is told this path;
   * - **unreadable bytes** cannot be a policy a Host will accept, so the file is repaired rather than left in
   *   the state that made the Host refuse to start;
   * - **a file that could not be read** (locked, denied, a directory in its place) is left exactly as it is,
   *   and the refusal is reported. Overwriting it here would replace a policy the user chose — possibly
   *   `read-only` — with the more permissive default, which is the one direction this store must never move
   *   silently.
   *
   * A file that already holds this mode is not rewritten at all. The previous version wrote on every load,
   * which turned every launch into a window in which an interrupted write destroyed the policy.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          `Could not read the permission policy at ${this.file}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      this.mode = defaultMode;
      await this.write();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.mode = defaultMode;
      await this.write();
      return;
    }
    const mode = modeFromPolicy(parsed);
    this.mode = mode ?? defaultMode;
    if (mode === undefined || !isDeepStrictEqual(parsed, permissionPolicyForMode(mode)))
      await this.write();
  }

  async save(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.write();
  }

  /**
   * Written through a temporary file and a rename, like the UI settings beside it.
   *
   * `writeFile` truncates in place, and `load()` above cannot tell a half-written file from a policy nobody
   * chose — so a process killed during a save turned the next launch into a silent reset of the user's mode.
   * The replacement is atomic: a reader sees either the previous complete policy or the new one.
   */
  private async write(): Promise<void> {
    const policy = permissionPolicyForMode(this.mode);
    new PermissionPolicy(policy);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify(policy, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
