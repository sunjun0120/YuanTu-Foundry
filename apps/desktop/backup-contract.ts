export interface BackupEntry {
  id: string;
  createdAt: string;
  bytes: number;
}
export interface BackupView {
  enabled: boolean;
  backups: BackupEntry[];
  error: string | null;
}
export type BackupCommand =
  | { type: 'get' }
  | { type: 'create' }
  | { type: 'configure'; enabled: boolean }
  | { type: 'restore'; id: string };
export type BackupReply =
  | { ok: true; view: BackupView; recoveryDirectory?: string; cancelled?: boolean }
  | { ok: false; error: string };
export function parseBackupCommand(input: unknown): BackupCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid backup command');
  const value = input as Record<string, unknown>;
  const fields =
    value.type === 'configure'
      ? ['type', 'enabled']
      : value.type === 'restore'
        ? ['type', 'id']
        : ['type'];
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('Unknown backup command field');
  if (value.type === 'get' || value.type === 'create') return { type: value.type };
  if (value.type === 'configure' && typeof value.enabled === 'boolean')
    return { type: 'configure', enabled: value.enabled };
  if (
    value.type === 'restore' &&
    typeof value.id === 'string' &&
    /^\d+-[a-f0-9-]{36}\.sqlite$/.test(value.id)
  )
    return { type: 'restore', id: value.id };
  throw new Error('Invalid backup command');
}
