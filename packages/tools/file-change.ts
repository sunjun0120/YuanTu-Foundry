import path from 'node:path';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { structuredPatch, formatPatch } from 'diff';
import type { FileChange, PreparedTool, ToolContext } from '../protocol/index.ts';
import type { Workspace } from './files.ts';
import type { MutationGates } from './fs-observation.ts';
import { writeAll, atomicWriteFile } from './write-all.ts';

const noFollow = constants.O_NOFOLLOW ?? 0;

function openMutationFile(
  file: string,
  flags: number,
): Promise<import('node:fs/promises').FileHandle> {
  return open(file, flags | noFollow);
}
function preview(
  file: string,
  before: string,
  after: string,
  kind: FileChange['kind'],
): FileChange {
  const structured = structuredPatch(
    kind === 'create' ? '/dev/null' : file,
    file,
    before,
    after,
    '',
    '',
    { context: 3, timeout: 150, maxEditLength: 10000 },
  );
  const patch = structured ? formatPatch(structured) : undefined;
  const lines = structured?.hunks.flatMap((hunk) => hunk.lines) ?? [];
  return {
    path: file,
    kind,
    patch: (patch ?? 'Diff too complex to display; inspect the complete tool arguments.').slice(
      0,
      32000,
    ),
    added: lines.filter((l) => l.startsWith('+')).length,
    removed: lines.filter((l) => l.startsWith('-')).length,
    truncated: patch === undefined || patch.length > 32000,
  };
}
async function readBytes(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Expected a regular file <= 1MB');
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    if (bytes.length > 1_000_000 || !Buffer.from(text).equals(bytes) || text.includes('\0'))
      throw new Error('File must be valid UTF-8 text <= 1MB');
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function prepareFileChange(
  workspace: Workspace,
  args: Record<string, unknown>,
  kind: FileChange['kind'],
  context: ToolContext,
  gates: MutationGates,
): Promise<PreparedTool> {
  context.signal.throwIfAborted();
  const input = String(args.path);
  const file = await workspace.resolve(input, kind === 'create');
  const instructions = await gates.instructions(input);
  if (instructions)
    throw new Error(
      'Read the applicable project instructions before retrying this change:\n' + instructions,
    );
  let before: Buffer = Buffer.alloc(0);
  let after: string;
  if (kind === 'edit') {
    // Before anything is computed from the file's bytes: has this run looked at them? Asked here rather than
    // after the match attempt so a blind edit hears "read it first" instead of a message about `old_text` that
    // reads as "your text was slightly wrong" and invites another guess.
    await gates.observations.assertRead(input);
    before = await readBytes(file);
    const source = before.toString('utf8'),
      old = String(args.old_text),
      index = source.indexOf(old);
    if (index < 0 || source.indexOf(old, index + 1) >= 0)
      throw new Error('old_text must match exactly once');
    after = source.slice(0, index) + String(args.new_text) + source.slice(index + old.length);
  } else {
    try {
      await lstat(file);
      throw new Error('File already exists; use edit_file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    after = String(args.content);
  }
  const next = Buffer.from(after);
  if (next.length > 1_000_000 || after.includes('\0'))
    throw new Error('New file content must be UTF-8 text <= 1MB');
  const change = preview(
    path.relative(workspace.root, file).split(path.sep).join('/'),
    before.toString('utf8'),
    after,
    kind,
  );
  return {
    change,
    async execute(ctx) {
      ctx.signal.throwIfAborted();
      await workspace.resolve(input, kind === 'create');
      const journalId = ctx.fileJournal?.prepare(change, kind === 'create' ? null : before, next);
      if (kind === 'edit') {
        // Re-check the exact bytes after approval, then atomically replace the file so a
        // crash can never leave it torn between its before and after states.
        const handle = await openMutationFile(file, constants.O_RDONLY);
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.size !== before.length ||
            !(await handle.readFile()).equals(before)
          )
            throw new Error(
              'File changed since approval preview; read it again and request a new edit',
            );
        } finally {
          await handle.close();
        }
        ctx.signal.throwIfAborted();
        await workspace.resolve(input);
        await atomicWriteFile(file, next);
        if (journalId) ctx.fileJournal!.applied(journalId);
        await gates.observations.settle({ written: [input] });
        return {
          isError: false,
          content: `Updated ${input}`,
          change: { ...change, ...(journalId ? { id: journalId } : {}) },
        };
      }
      const handle = await openMutationFile(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      try {
        ctx.signal.throwIfAborted();
        await workspace.resolve(input);
        await writeAll(handle, next);
        await handle.truncate(next.length);
        await handle.sync();
        if (journalId) ctx.fileJournal!.applied(journalId);
        // The model wrote these bytes, so it has in effect seen the file it just created.
        await gates.observations.settle({ written: [input] });
        return {
          isError: false,
          content: `Created ${input}`,
          change: { ...change, ...(journalId ? { id: journalId } : {}) },
        };
      } finally {
        await handle.close();
      }
    },
  };
}
