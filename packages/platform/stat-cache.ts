import type { Stats } from 'node:fs';

/**
 * A value derived from one file, kept until the file changes.
 *
 * Some files are read on every model round so that an edit made during a run is seen by the next round — skills
 * and saved memories are the two. Re-reading and re-parsing them when nothing changed was the cost, not seeing
 * the edit. The key is what a write changes: size, modification and change times, and the inode, so a file
 * replaced by rename (the usual way an editor saves) is a different file even with the same size and mtime.
 */
export interface StatKey {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export function statKey(stat: Stats): StatKey {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sameKey(left: StatKey, right: StatKey): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino
  );
}

export class StatCache<T> {
  private readonly entries = new Map<string, { key: StatKey; value: T }>();
  private readonly limit: number;
  constructor(limit = 256) {
    this.limit = limit;
  }
  /** The value for `file` at `key`, computed by `read` only when the file is new to the cache or changed. */
  get(file: string, key: StatKey, read: () => T): T {
    const cached = this.entries.get(file);
    if (cached && sameKey(cached.key, key)) {
      // Refreshed to the newest position, so the bound evicts the file read least recently.
      this.entries.delete(file);
      this.entries.set(file, cached);
      return cached.value;
    }
    const value = read();
    this.entries.delete(file);
    this.entries.set(file, { key, value });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  delete(file: string): void {
    this.entries.delete(file);
  }
}
