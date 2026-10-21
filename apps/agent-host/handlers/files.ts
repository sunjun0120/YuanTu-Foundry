import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extensionTools } from '../../../packages/resources/extensions.ts';
import { loadInstructions } from '../../../packages/tools/instructions.ts';
import { discoverSkills } from '../../../packages/resources/skills.ts';
import { sniffImageType, MAX_IMAGE_BYTES } from '../../../packages/protocol/images.ts';
import {
  FILE_PREVIEW_BYTES,
  FILE_TREE_ENTRY_LIMIT,
  OFFICE_PREVIEW_BYTES,
} from '../../../packages/protocol/rpc.ts';
import type { WorkspaceEntry } from '../../../packages/protocol/rpc.ts';
import { officePreviewHtml } from '../../../packages/office/render.ts';
import type { OfficeFormat } from '../../../packages/office/automation.ts';
// The class that owns the workspace's path rules. `files.list`/`files.read` reuse it rather than restating
// its containment and ignore rules, so a client's file tree and the model's own tools cannot disagree about
// which paths exist.
import { Workspace } from '../../../packages/tools/files.ts';
import { required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

/** The Office formats the preview panel can render, by the file's own extension. */
function officeFormatOf(relative: string): OfficeFormat | undefined {
  const extension = path.extname(relative).toLowerCase();
  return extension === '.docx' || extension === '.xlsx' || extension === '.pptx'
    ? (extension.slice(1) as OfficeFormat)
    : undefined;
}

/**
 * What is in the workspace, and what one file in it holds.
 *
 * Read-only by construction: nothing here writes, and every path goes through `Workspace`, which is the
 * containment rule the file tools already run under — realpath inside the root, no links, and the same
 * ignore list that hides `.git`, `node_modules` and credential names. Answering this in the Electron
 * main process instead would be a second copy of that decision on the far side of the IPC boundary, and
 * the copy that drifts is the one that lists `.env`.
 */
export const fileHandlers: Readonly<Record<string, Handler>> = {
  'resources.list': async (ctx) => ({
    instructions: loadInstructions(ctx.workspace).files,
    skills: discoverSkills(ctx.workspace),
    extensions: extensionTools(ctx.workspace).map((t) => t.name),
  }),
  'files.list': async (ctx, params) => {
    const files = new Workspace(ctx.workspace);
    const requested = typeof params.path === 'string' && params.path.trim() ? params.path : '.';
    // The requested directory is resolved first, so `..`, an absolute path and a hidden name are refused
    // here instead of being filtered out one entry at a time.
    const directory = await files.resolve(requested);
    const relative = path.relative(ctx.workspace, directory).split(path.sep).join('/');
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    const listing = await readdir(directory, { withFileTypes: true });
    const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    // Project trees put folders first and compare embedded numbers by value (file2 before file10).
    // Sort before the entry cap so every client receives the same ordered prefix.
    for (const entry of listing.sort(
      (first, second) =>
        Number(second.isDirectory()) - Number(first.isDirectory()) ||
        names.compare(first.name, second.name) ||
        first.name.localeCompare(second.name),
    )) {
      // A link or a device: the resolver refuses the first below, and the second is a file whose read can
      // block — a tree that offers one can hang the Host, which is worse than not offering it.
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Every child is offered to the same resolver, so the tree can only ever show paths the model may
      // open: a name this refuses is exactly a name `read_file` would refuse too.
      try {
        await files.resolve(child);
      } catch {
        continue;
      }
      if (entries.length >= FILE_TREE_ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        path: child,
        kind: entry.isDirectory() ? 'directory' : 'file',
      });
    }
    return { path: relative, entries, truncated };
  },
  /**
   * One file's bytes, in the only form a preview can show them without inventing content.
   *
   * The bytes decide what this is — the signature for an image, a NUL in the window for "not text" — never
   * the name. An extension is a claim, and a `.png` that is really a JPEG is the one file a preview must
   * not hand to an `<img>`: a broken image reads as a broken file rather than as a mislabelled one.
   */
  'files.read': async (ctx, params) => {
    const target = required(params, 'path');
    const files = new Workspace(ctx.workspace);
    const file = await files.resolve(target);
    const relative = path.relative(ctx.workspace, file).split(path.sep).join('/');
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      // A directory opens and then refuses to be read, and a device file can block the read; both are
      // "there is nothing here to show", not a path the client got wrong.
      if (!info.isFile())
        return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'not-a-file' };
      const window = Buffer.alloc(Math.min(info.size, FILE_PREVIEW_BYTES + 1));
      const { bytesRead } = await handle.read(window, 0, window.length, 0);
      const head = window.subarray(0, bytesRead);
      const mimeType = sniffImageType(head);
      if (mimeType) {
        if (info.size > MAX_IMAGE_BYTES)
          return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'too-large' };
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead)
            throw new Error('File changed while reading its image preview; reopen it');
          offset += bytesRead;
        }
        return {
          path: relative,
          bytes: info.size,
          kind: 'image',
          mimeType,
          data: bytes.toString('base64'),
        };
      }
      // The same window `Workspace.read` refuses: bytes with a NUL in them are not text, and decoding them
      // would produce replacement characters that look like the file's content. Taken from the bytes
      // already in hand rather than by reading the file a second time, which is how the two would come to
      // disagree about what the file holds.
      if (head.includes(0)) {
        /*
         * A binary file is not automatically unshowable: an Office package is binary and the repository already
         * knows how to render it as a self-contained page. The panel used to answer a .docx with 二进制文件，无法
         * 以文本预览, which sent the reader looking for the file in another program while this Host could have
         * drawn it. `formatOfName` is the only reader of the extension, and it only chooses a renderer — the
         * bytes still decide what is displayed, and a renderer that fails leaves the honest "cannot preview".
         */
        const office = officeFormatOf(relative);
        if (office && info.size <= OFFICE_PREVIEW_BYTES) {
          try {
            const language =
              typeof params.locale === 'string' && params.locale.toLowerCase().startsWith('en')
                ? 'en'
                : 'zh';
            const html = await officePreviewHtml(office, file, language);
            if (Buffer.byteLength(html) <= OFFICE_PREVIEW_BYTES)
              return { path: relative, bytes: info.size, kind: 'html', html };
          } catch {
            // Fall through to the binary refusal: a document this renderer cannot read is still not text.
          }
        }
        return { path: relative, bytes: info.size, kind: 'unsupported', reason: 'binary' };
      }
      return {
        path: relative,
        bytes: info.size,
        kind: 'text',
        text: head.subarray(0, FILE_PREVIEW_BYTES).toString('utf8'),
        // Without this a preview that stops at the budget reads as the whole file.
        ...(info.size > FILE_PREVIEW_BYTES ? { truncated: true } : {}),
      };
    } finally {
      await handle.close();
    }
  },
};
