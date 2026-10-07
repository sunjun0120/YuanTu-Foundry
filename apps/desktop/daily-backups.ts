import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactSecrets } from '../../packages/core/errors.ts';
import type { BackupView } from './backup-contract.ts';
import type { BackupAction, BackupResult } from './database-backup-worker.ts';

type Execute = (file: string, operation: BackupAction, id?: string) => Promise<BackupResult>;
export class DailyBackups {
  private enabled = false;
  private configurationError: string | null = null;
  private configuration = Promise.resolve();
  private readonly pending = new Map<string, Promise<BackupResult>>();
  private readonly pendingKinds = new Map<string, 'tick' | 'create'>();
  private readonly errors = new Map<string, string>();
  private readonly file: string;
  private readonly execute: Execute;
  constructor(file: string, execute: Execute) {
    this.file = file;
    this.execute = execute;
  }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as { enabled?: unknown };
      if (typeof value.enabled !== 'boolean') throw new Error('Invalid backup settings');
      this.enabled = value.enabled;
    } catch (error) {
      this.enabled = false;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.configurationError = redactSecrets(
          `Could not load backup settings: ${error instanceof Error ? error.message : 'Invalid backup settings'}`,
        );
    }
  }
  async configure(enabled: boolean): Promise<void> {
    const job = this.configuration.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const stage = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(stage, JSON.stringify({ enabled }), { flag: 'wx', mode: 0o600 });
        await rename(stage, this.file);
        this.enabled = enabled;
        this.configurationError = null;
      } finally {
        await rm(stage, { force: true });
      }
    });
    this.configuration = job.catch(() => {});
    await job;
  }
  private job(
    file: string,
    kind: 'tick' | 'create',
    action: () => Promise<BackupResult>,
  ): Promise<BackupResult> {
    const existing = this.pending.get(file);
    if (existing) return existing;
    const work = action()
      .then(
        (result) => {
          this.errors.delete(file);
          return result;
        },
        (error: unknown) => {
          this.errors.set(
            file,
            redactSecrets(error instanceof Error ? error.message : 'Database backup failed'),
          );
          throw error;
        },
      )
      .finally(() => {
        if (this.pending.get(file) === work) {
          this.pending.delete(file);
          this.pendingKinds.delete(file);
        }
      });
    this.pending.set(file, work);
    this.pendingKinds.set(file, kind);
    return work;
  }
  async view(file: string): Promise<BackupView> {
    try {
      const result = await this.execute(file, 'list');
      return {
        enabled: this.enabled,
        backups: result.backups,
        error: this.configurationError ?? this.errors.get(file) ?? null,
      };
    } catch (error) {
      return {
        enabled: this.enabled,
        backups: [],
        error: redactSecrets(error instanceof Error ? error.message : 'Database backup failed'),
      };
    }
  }
  async create(file: string): Promise<BackupView> {
    if (this.pendingKinds.get(file) === 'tick') await this.pending.get(file)?.catch(() => {});
    await this.job(file, 'create', () => this.execute(file, 'create'));
    return this.view(file);
  }
  async tick(file: string, now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.job(file, 'tick', async () => {
        const result = await this.execute(file, 'list');
        const latest = result.backups[0];
        return latest && now - Date.parse(latest.createdAt) < 86_400_000
          ? result
          : this.execute(file, 'create');
      });
    } catch {
      /* An optional backup failure must not interrupt a run. The settings page shows it. */
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values(), this.configuration]);
  }
}
