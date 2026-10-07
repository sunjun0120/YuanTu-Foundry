import type { Tool } from '../protocol/index.ts';
import { verifyFileDelivery } from '../core/delivery.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

export function deliveryTool(root: string): Tool {
  return {
    name: 'verify_file_delivery',
    isConcurrencySafe: parallelRead,
    description:
      'Independently verify a file before claiming delivery. Checks a workspace file exists, is regular and nonempty, records size and SHA-256, and validates basic structure for supported formats. For visual layout or full document semantics, use a suitable renderer/parser as well. This is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        format: {
          type: 'string',
          enum: [
            'auto',
            'binary',
            'text',
            'pdf',
            'docx',
            'xlsx',
            'pptx',
            'xls',
            'png',
            'jpeg',
            'zip',
          ],
        },
        minBytes: { type: 'integer', minimum: 1, maximum: 100000000 },
        sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => ({
      isError: false,
      content: JSON.stringify(
        await verifyFileDelivery(root, {
          path: String(args.path),
          ...(args.format ? { format: args.format as 'auto' } : {}),
          ...(args.minBytes ? { minBytes: Number(args.minBytes) } : {}),
          ...(args.sha256 ? { sha256: String(args.sha256) } : {}),
        }),
      ),
    }),
  };
}
