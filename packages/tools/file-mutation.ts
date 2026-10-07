import path from 'node:path';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { applyPatch, formatPatch, structuredPatch } from 'diff';
import type {
  FileChange,
  FileChangeKind,
  FileSnapshot,
  PreparedTool,
  ToolContext,
} from '../protocol/index.ts';
import type { Workspace } from './files.ts';
import type { MutationGates } from './fs-observation.ts';
import { writeAll, atomicWriteFile } from './write-all.ts';

const MAX_FILE_BYTES = 1_000_000;
const MAX_GROUP_BYTES = 10_000_000;
const noFollow = constants.O_NOFOLLOW ?? 0;

function openMutationFile(
  file: string,
  flags: number,
): Promise<import('node:fs/promises').FileHandle> {
  return open(file, flags | noFollow);
}

export async function readMutationBytes(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error('Expected a regular file <= 1MB');
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || text.includes('\0'))
      throw new Error('File must be valid UTF-8 text <= 1MB');
    return bytes;
  } finally {
    await handle.close();
  }
}

export function filePreview(
  file: string,
  before: string,
  after: string,
  kind: FileChangeKind,
): FileChange {
  const structured = structuredPatch(
    kind === 'create' ? '/dev/null' : file,
    kind === 'delete' ? '/dev/null' : file,
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
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
    truncated: patch === undefined || patch.length > 32000,
  };
}

export function groupedPreview(kind: 'move' | 'batch', changes: FileChange[]): FileChange {
  return {
    path: changes.map((change) => change.path).join(', '),
    kind,
    patch: changes
      .map((change) => change.patch)
      .join('\n')
      .slice(0, 32000),
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0),
    truncated:
      changes.some((change) => change.truncated) ||
      changes.reduce((sum, change) => sum + change.patch.length, 0) > 32000,
    changes,
  };
}

function validateSnapshots(files: FileSnapshot[]): void {
  if (!files.length || files.length > 100)
    throw new Error('A file operation must affect 1 to 100 paths');
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Duplicate file snapshot: ${file.path}`);
    seen.add(file.path);
    bytes += file.before?.byteLength ?? 0;
    bytes += file.after?.byteLength ?? 0;
    if (
      (file.before?.byteLength ?? 0) > MAX_FILE_BYTES ||
      (file.after?.byteLength ?? 0) > MAX_FILE_BYTES
    )
      throw new Error('File snapshot exceeds 1MB');
  }
  if (bytes > MAX_GROUP_BYTES) throw new Error('File operation snapshots exceed 10MB');
}

async function currentBytes(workspace: Workspace, input: string): Promise<Buffer | null> {
  try {
    return await readMutationBytes(await workspace.resolve(input));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSnapshot(workspace: Workspace, snapshot: FileSnapshot): Promise<void> {
  const current = await currentBytes(workspace, snapshot.path);
  if (
    (current === null) !== (snapshot.before === null) ||
    (current !== null && snapshot.before !== null && !current.equals(snapshot.before))
  )
    throw new Error(
      `${snapshot.path} changed since approval preview; inspect it and request a new operation`,
    );
}

async function writeSnapshot(workspace: Workspace, snapshot: FileSnapshot): Promise<void> {
  const file = await workspace.resolve(snapshot.path, snapshot.before === null);
  if (snapshot.after === null) {
    await unlink(file);
    return;
  }
  const after = Buffer.from(snapshot.after);
  if (snapshot.before !== null) {
    // Overwrite an existing file atomically so a crash cannot tear it between states.
    await atomicWriteFile(file, after);
    return;
  }
  const handle = await openMutationFile(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
  );
  try {
    await writeAll(handle, after);
    await handle.truncate(after.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function prepareMutation(
  workspace: Workspace,
  change: FileChange,
  snapshots: FileSnapshot[],
  options: {
    gates?: MutationGates;
    effects?: () => Promise<void>;
    /**
     * What the model is considered to know once this change lands. Defaults to "every file it wrote, none of the
     * ones it removed", which is right whenever the bytes came from the model's own arguments. A move is the one
     * shape where a written path is *not* authored — the bytes were copied from somewhere the model may never
     * have read — and its caller says so explicitly.
     */
    known?: { written?: readonly string[]; removed?: readonly string[] };
  } = {},
): PreparedTool {
  validateSnapshots(snapshots);
  return {
    change,
    async execute(ctx: ToolContext) {
      ctx.signal.throwIfAborted();
      for (const snapshot of snapshots) await assertSnapshot(workspace, snapshot);
      ctx.signal.throwIfAborted();
      if (
        ctx.fileJournal &&
        !ctx.fileJournal.prepareGroup &&
        (snapshots.length !== 1 || snapshots[0]!.after === null)
      )
        throw new Error('This journal does not support grouped or deleting file operations');
      const journalId = ctx.fileJournal
        ? ctx.fileJournal.prepareGroup
          ? ctx.fileJournal.prepareGroup(change, snapshots)
          : snapshots.length === 1 && snapshots[0]!.after !== null
            ? ctx.fileJournal.prepare(change, snapshots[0]!.before, snapshots[0]!.after)
            : undefined
        : undefined;
      if (options.effects) await options.effects();
      else
        for (const snapshot of snapshots) {
          ctx.signal.throwIfAborted();
          await assertSnapshot(workspace, snapshot);
          await writeSnapshot(workspace, snapshot);
        }
      if (journalId) ctx.fileJournal!.applied(journalId);
      // What the model now knows: the files it wrote itself, and forget the ones that are gone.
      await options.gates?.observations.settle(
        options.known ?? {
          written: snapshots.filter((file) => file.after !== null).map((file) => file.path),
          removed: snapshots.filter((file) => file.after === null).map((file) => file.path),
        },
      );
      return {
        isError: false,
        content: `Applied ${change.kind} to ${snapshots.map((file) => file.path).join(', ')}`,
        change: { ...change, ...(journalId ? { id: journalId } : {}) },
      };
    },
  };
}

export async function prepareApplyPatch(
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
  gates: MutationGates,
): Promise<PreparedTool> {
  context.signal.throwIfAborted();
  const input = String(args.path);
  const file = await workspace.resolve(input);
  const instructions = await gates.instructions(input);
  if (instructions)
    throw new Error(
      'Read the applicable project instructions before retrying this change:\n' + instructions,
    );
  // A patch is a claim about the file's current text, made entirely from memory, so it passes the same gate an
  // edit does — before the diff is computed and long before a person is asked to approve it.
  await gates.observations.assertRead(input);
  const before = await readMutationBytes(file);
  const source = before.toString('utf8');
  const after = applyPatch(source, String(args.patch), { fuzzFactor: 0 });
  if (after === false) throw new Error('Patch does not apply exactly to the current file');
  const next = Buffer.from(after);
  if (next.length > MAX_FILE_BYTES || after.includes('\0'))
    throw new Error('New file content must be UTF-8 text <= 1MB');
  const relative = path.relative(workspace.root, file).split(path.sep).join('/');
  return prepareMutation(
    workspace,
    filePreview(relative, source, after, 'edit'),
    [{ path: relative, before, after: next }],
    { gates },
  );
}

export async function prepareDelete(
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
  gates: MutationGates,
): Promise<PreparedTool> {
  context.signal.throwIfAborted();
  const input = String(args.path);
  const file = await workspace.resolve(input);
  const instructions = await gates.instructions(input);
  if (instructions)
    throw new Error(
      'Read the applicable project instructions before retrying this change:\n' + instructions,
    );
  const before = await readMutationBytes(file);
  const relative = path.relative(workspace.root, file).split(path.sep).join('/');
  return prepareMutation(
    workspace,
    filePreview(relative, before.toString('utf8'), '', 'delete'),
    [{ path: relative, before, after: null }],
    { gates },
  );
}

export async function prepareMove(
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
  gates: MutationGates,
): Promise<PreparedTool> {
  context.signal.throwIfAborted();
  const fromInput = String(args.from),
    toInput = String(args.to);
  const from = await workspace.resolve(fromInput);
  const to = await workspace.resolve(toInput, true);
  if (from === to) throw new Error('Source and destination must differ');
  const instructions = [await gates.instructions(fromInput), await gates.instructions(toInput)]
    .filter(Boolean)
    .join('\n');
  if (instructions)
    throw new Error(
      'Read the applicable project instructions before retrying this change:\n' + instructions,
    );
  const before = await readMutationBytes(from);
  try {
    await lstat(to);
    throw new Error('Destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fromPath = path.relative(workspace.root, from).split(path.sep).join('/');
  const toPath = path.relative(workspace.root, to).split(path.sep).join('/');
  const changes = [
    filePreview(fromPath, before.toString('utf8'), '', 'delete'),
    filePreview(toPath, '', before.toString('utf8'), 'create'),
  ];
  const snapshots: FileSnapshot[] = [
    { path: fromPath, before, after: null },
    { path: toPath, before: null, after: before },
  ];
  return prepareMutation(workspace, groupedPreview('move', changes), snapshots, {
    gates,
    // The destination holds bytes the model did not write and may never have read, so it is *not* recorded as
    // something this run knows; the source is forgotten because it is no longer there. The cost of being strict
    // is the model reading the file once before changing it.
    known: { removed: [fromPath] },
    effects: async () => {
      for (const snapshot of snapshots) await assertSnapshot(workspace, snapshot);
      context.signal.throwIfAborted();
      await rename(from, to);
    },
  });
}

export async function prepareBatchEdit(
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
  gates: MutationGates,
): Promise<PreparedTool> {
  context.signal.throwIfAborted();
  const edits = args.edits as { path: string; old_text: string; new_text: string }[];
  const states = new Map<string, { file: string; before: Buffer; text: string }>();
  for (const edit of edits) {
    let state = states.get(edit.path);
    if (!state) {
      const file = await workspace.resolve(edit.path);
      const instructions = await gates.instructions(edit.path);
      if (instructions)
        throw new Error(
          'Read the applicable project instructions before retrying this change:\n' + instructions,
        );
      // Per path, and before any replacement is attempted: a batch that touches one unread file is refused as a
      // whole, naming the file, rather than applying its other steps and failing partway.
      await gates.observations.assertRead(edit.path);
      const before = await readMutationBytes(file);
      state = { file, before, text: before.toString('utf8') };
      states.set(edit.path, state);
    }
    const index = state.text.indexOf(edit.old_text);
    if (index < 0 || state.text.indexOf(edit.old_text, index + 1) >= 0)
      throw new Error(`${edit.path}: old_text must match exactly once at its batch step`);
    state.text =
      state.text.slice(0, index) + edit.new_text + state.text.slice(index + edit.old_text.length);
    if (Buffer.byteLength(state.text) > MAX_FILE_BYTES || state.text.includes('\0'))
      throw new Error(`${edit.path}: new file content must be UTF-8 text <= 1MB`);
  }
  const changes: FileChange[] = [];
  const snapshots: FileSnapshot[] = [];
  for (const [, state] of states) {
    const relative = path.relative(workspace.root, state.file).split(path.sep).join('/');
    changes.push(filePreview(relative, state.before.toString('utf8'), state.text, 'edit'));
    snapshots.push({ path: relative, before: state.before, after: Buffer.from(state.text) });
  }
  return prepareMutation(workspace, groupedPreview('batch', changes), snapshots, { gates });
}
