import { verifyFileDelivery } from '../core/delivery.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Tool, ToolContext } from '../protocol/index.ts';

/**
 * Declaring deliverables, and why this is a tool rather than a paragraph.
 *
 * A run that produced a spreadsheet, a report or a screenshot has one thing left to do that prose cannot do
 * well: say *which* files the person should open. A path in an answer is a string they have to find; a
 * declaration is a fact the session records, so the desktop can offer the file and a reopened session can
 * still show what was handed over (see `packages/protocol/deliverables.ts`).
 *
 * Three decisions:
 *
 * 1. **It verifies before it declares.** Every path goes through `verifyFileDelivery`, the same check
 *    `verify_file_delivery` runs: a regular, non-empty file inside the workspace, with its size, digest and
 *    basic format structure established at the moment of the declaration. "Here is your report" is a claim
 *    about a specific revision of a path, and a file that is missing, empty or half-written is exactly the
 *    claim this tool must not make. A failed check fails the call — there is no partial presentation.
 * 2. **It declares; it does not copy.** Nothing is moved, renamed or duplicated. The user opens the file
 *    where it already is, which is why the digest matters: an edit after the fact is then visible rather than
 *    implied.
 * 3. **It survives a read-only run.** Like the checklist, this touches no workspace file, so it declares no
 *    permission: a planning run may point at the files it is proposing to change. It is *not* in
 *    `EXPLORE_TOOLS`, though — a delegated child presents nothing to the user, and the list is the session's,
 *    not the child's.
 */
const MAX_FILES = 4;
const MAX_PATH_CHARS = 4096;
const MAX_DESCRIPTION_CHARS = 500;
function normalize(value: unknown): { path: string; description?: string }[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES)
    throw new Error(`files must be an array of 1 to ${MAX_FILES} entries`);
  const seen = new Set<string>();
  return value.map((entry) => {
    const file = (entry ?? {}) as Record<string, unknown>;
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path || path.length > MAX_PATH_CHARS) throw new Error('Every entry needs a valid path');
    // Two entries for one path would present the same file twice, and the fold would keep the last one
    // anyway: refusing says so instead of letting the list quietly disagree with the call.
    if (seen.has(path)) throw new Error(`Path "${path}" is listed more than once`);
    seen.add(path);
    if (file.description !== undefined && typeof file.description !== 'string')
      throw new Error('A description must be a string');
    const description =
      typeof file.description === 'string'
        ? file.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
        : '';
    return { path, ...(description ? { description } : {}) };
  });
}
/** What the model reads back: its own list, with the facts that were established about each file. */
function render(files: PresentedFile[]): string {
  return [
    'Presented to the user:',
    ...files.map(
      (file) =>
        `- ${file.path} (${file.bytes} bytes, sha256 ${file.sha256.slice(0, 12)}…)${file.description ? ` — ${file.description}` : ''}`,
    ),
    'These files are now shown to the user as deliverables of this session. Do not repeat their contents in your reply; say what they are and what to do with them.',
  ].join('\n');
}
export function presentTool(root: string): Tool {
  return {
    name: 'present',
    description:
      'Declare workspace files as the finished deliverables of this task, so the user can open them: a document, spreadsheet, deck, image, report or patch you produced. Use it for the files the user needs, not for files you merely read or created in passing, and not instead of answering. Each path must exist inside the workspace — it is verified (regular, nonempty, size and SHA-256) before it is declared — and declaring is not copying: the files stay where they are. At most 4 per call.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FILES,
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_PATH_CHARS,
                description: 'Path of an existing regular file, relative to the workspace.',
              },
              description: {
                type: 'string',
                maxLength: MAX_DESCRIPTION_CHARS,
                description: 'Brief description of the file for the user.',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    execute: async (args, context: ToolContext) => {
      context.signal.throwIfAborted();
      try {
        const request = normalize(args.files);
        const at = new Date().toISOString();
        const files: PresentedFile[] = [];
        for (const entry of request) {
          context.signal.throwIfAborted();
          // Verification first, for every file, before anything is recorded: a call that presents three
          // files must not leave two of them declared because the third was missing.
          const evidence = await verifyFileDelivery(root, { path: entry.path });
          files.push({
            path: evidence.path,
            bytes: evidence.bytes,
            sha256: evidence.sha256,
            at,
            ...(entry.description ? { description: entry.description } : {}),
          });
        }
        if (!context.deliverables)
          return {
            isError: true,
            content:
              'No deliverable list is wired into this run, so the declaration cannot be recorded. Say which files you produced in your reply instead.',
          };
        context.deliverables.write(files);
        return { isError: false, content: render(files) };
      } catch (error) {
        return {
          isError: true,
          content: `Nothing was presented: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
