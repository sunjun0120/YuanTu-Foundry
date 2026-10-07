import { readFile, writeFile } from 'node:fs/promises';
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

  async load(): Promise<void> {
    try {
      this.mode =
        modeFromPolicy(JSON.parse(await readFile(this.file, 'utf8')) as unknown) ?? defaultMode;
    } catch {
      this.mode = defaultMode;
    }
    await this.write();
  }

  async save(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.write();
  }

  private async write(): Promise<void> {
    const policy = permissionPolicyForMode(this.mode);
    new PermissionPolicy(policy);
    await writeFile(this.file, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  }
}
