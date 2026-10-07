import { readFile, writeFile } from 'node:fs/promises';
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
  async save(value: UiSettings): Promise<void> {
    this.value = parseUiSettings(value);
    await writeFile(this.file, JSON.stringify(this.value, null, 2) + '\n', 'utf8');
  }
}
