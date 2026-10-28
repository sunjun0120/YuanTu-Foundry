// apps/desktop/analysis-source.ts
/**
 * Puts a source archive the user attached into the workspace, where `analysis_upload_source` can send it.
 *
 * A dropped or picked file arrives as a path; the main process reads and stores it under a protected path lease,
 * so the renderer never ships its bytes through IPC. A pasted file has no path and arrives as bytes. Either way the archive is
 * stored as it is (never unpacked here) under `analysis-inputs/`, and an earlier archive with the same name is kept:
 * the new one gets a numbered name instead.
 */
import { lstat } from 'node:fs/promises';
import { PathLease } from '../../packages/builtin-services/path-lease.ts';
import path from 'node:path';
import { MAX_SOURCE_ARCHIVE_BYTES, SOURCE_ARCHIVE } from './attachment-contract.ts';
import { mainText } from './i18n.ts';

const INPUTS = 'analysis-inputs';

export async function stageSourceArchive(
  workspace: string,
  name: string,
  source: { path: string } | { data: Uint8Array },
): Promise<{ path: string; size: number }> {
  if (
    !SOURCE_ARCHIVE.test(name) ||
    path.basename(name) !== name ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name)
  )
    throw new Error(mainText('analysis.sourceInvalid'));
  // The path comes from the renderer, so it is held to the name that was checked above: a dropped file's name is
  // its path's last part. Otherwise a compromised renderer could pair an archive name with any file on the disk.
  if ('path' in source && (!path.isAbsolute(source.path) || path.basename(source.path) !== name))
    throw new Error(mainText('analysis.sourceInvalid'));
  const lease = await PathLease.open();
  try {
    await lease.lockDirectory(workspace);
    const directory = path.join(workspace, INPUTS);
    await lease.mkdir(directory);
    await lease.lockDirectory(directory);
    let bytes: Buffer;
    if ('path' in source) {
      await lease.lockFile(source.path);
      const info = await lstat(source.path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(mainText('analysis.sourceInvalid'));
      if (!info.size || info.size > MAX_SOURCE_ARCHIVE_BYTES)
        throw new Error(mainText('analysis.sourceTooLarge'));
      bytes = await lease.readFile(source.path);
    } else {
      if (!source.data.byteLength || source.data.byteLength > MAX_SOURCE_ARCHIVE_BYTES)
        throw new Error(mainText('analysis.sourceTooLarge'));
      bytes = Buffer.from(source.data);
    }
    if (!bytes.length || bytes.length > MAX_SOURCE_ARCHIVE_BYTES)
      throw new Error(mainText('analysis.sourceTooLarge'));
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = attempt
        ? name.replace(SOURCE_ARCHIVE, (extension) => `-${attempt}${extension}`)
        : name;
      try {
        await lease.createFile(path.join(directory, candidate), bytes);
        return { path: `${INPUTS}/${candidate}`, size: bytes.length };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await lease.close();
  }
  throw new Error(mainText('analysis.sourceInvalid'));
}
