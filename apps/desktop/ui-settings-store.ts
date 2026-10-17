import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultUiSettings, parseUiSettings, type UiSettings } from './ui-settings.ts';

export class UiSettingsStore {
  private value = defaultUiSettings();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  get view(): UiSettings {
    return { ...this.value };
  }
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      this.value = parseUiSettings(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.value = defaultUiSettings();
    }
  }
  /**
   * Written through a temporary file and a rename, like every other store in this directory.
   *
   * A plain `writeFile` truncated the file in place, so a process killed part-way through left invalid JSON —
   * and `load()` reads that as "no settings" and overwrites it with the defaults, turning a crash during a save
   * into a silent, permanent loss of the user's language, appearance and font size.
   */
  async save(value: UiSettings): Promise<void> {
    this.value = parseUiSettings(value);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify(this.value, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
