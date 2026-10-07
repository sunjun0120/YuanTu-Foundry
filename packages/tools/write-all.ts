import { open, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

interface Writer {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
}
export async function writeAll(file: Writer, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > data.length - offset)
      throw new Error('File write made no valid progress');
    offset += bytesWritten;
  }
}

/**
 * Atomically replace `file` with `data`. Writes to a unique temporary file in the same
 * directory, fsyncs it, then renames over the target, preserving the target's permission bits.
 * A crash therefore leaves the target in either its exact previous or exact new state, never a
 * torn mix — this is what the file journal's before/after reconciliation relies on.
 */
export async function atomicWriteFile(file: string, data: Buffer): Promise<void> {
  const directory = path.dirname(file);
  const base = path.basename(file);
  const temporary = path.join(directory, `.${base}.yuantu-${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(file)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode ?? 0o666,
  );
  let written = false;
  try {
    await writeAll(handle, data);
    if (mode !== undefined) await handle.chmod(mode);
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await unlink(temporary).catch(() => {});
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
