import { open, rm, stat } from 'node:fs/promises';

/** Publish an owned lock, unwinding failed writes without deleting a replacement owner's file. */
export async function createOwnedFileLease(
  filename: string,
  owner: Record<string, unknown>,
): Promise<{ release: () => Promise<void> }> {
  const handle = await open(filename, 'wx');
  let identity: Awaited<ReturnType<typeof stat>> | undefined;
  let closed = false,
    released = false;
  const release = async () => {
    if (released) return;
    if (!closed) {
      await handle.close();
      closed = true;
    }
    const current = await stat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (current) {
      if (!identity || current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error(`Lease file changed ownership; retained ${filename}`);
      await rm(filename);
    }
    released = true;
  };
  try {
    identity = await handle.stat();
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    return { release };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Lease publication failed; cleanup needs recovery',
        { cause: error },
      );
    }
    throw error;
  }
}
