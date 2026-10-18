import { link, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, FileChange, PreparedTool } from '../protocol/index.ts';
import { Workspace } from '../tools/files.ts';
import { verifyFileDelivery } from '../tools/file-delivery.ts';
import { loadInstructions } from '../tools/instructions.ts';
import { runOfficeAutomation, type OfficeFormat, type OfficeOperation } from './automation.ts';
import {
  PREVIEW_BACKENDS,
  previewExtensions,
  type PreviewBackend,
  type PreviewType,
} from './preview-backends.ts';
import {
  MAX_CREATED_SHEETS,
  MAX_DOCUMENT_BLOCKS,
  MAX_SLIDE_TABLE_ROWS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from './limits.ts';
import { libreOfficePreview, type OfficePreview } from './preview.ts';
import { assertExpansionWithinBudget } from './zip-entry.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

const formats = ['docx', 'xlsx', 'pptx'] as const;
const maximum = 20_000_000;
/**
 * Expansion ceilings for the inspect path, in uncompressed bytes.
 *
 * `office_inspect` is the one Office path that hands a package to a reader this repository does not own —
 * mammoth for DOCX, SheetJS for XLSX — and neither library consults a limit while inflating. The 20 MB check
 * below is about the *compressed* file, which is the number the package's author writes, so on its own it
 * accepts a 24 KB package that inflates to 24 MB. These ceilings are measured on the bytes as they arrive,
 * exactly like the per-part bounds the PPTX and XLSX edit paths already use.
 *
 * They are deliberately generous: a 16 MB part is a document of thousands of pages, and this tool returns at
 * most 12,000 characters of text, so a package past them is not something it could usefully inspect.
 */
const INSPECT_PART_BYTES = 16_000_000;
const INSPECT_TOTAL_BYTES = 48_000_000;
/**
 * Refuse a package that would inflate past those ceilings, before either library reads it.
 *
 * A file that is not a zip at all cannot inflate, so the 20 MB input limit is its whole bound: that branch
 * matters for SheetJS, which also reads spreadsheets that are not OOXML packages.
 */
async function assertInspectablePackage(bytes: Buffer, format: OfficeFormat): Promise<void> {
  const { default: JSZip } = await import('jszip');
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return;
  }
  await assertExpansionWithinBudget(
    zip,
    { part: INSPECT_PART_BYTES, total: INSPECT_TOTAL_BYTES },
    format.toUpperCase() + ' package',
  );
}
const formatOf = (name: string): OfficeFormat => {
  const format = path.extname(name).slice(1).toLowerCase();
  if (!formats.includes(format as OfficeFormat))
    throw new Error('Expected a .docx, .xlsx or .pptx file');
  return format as OfficeFormat;
};
async function inspect(file: string, format: OfficeFormat): Promise<string> {
  const bytes = await readFile(file);
  if (!bytes.length || bytes.length > maximum)
    throw new Error('Office file must be 1 byte to 20 MB');
  await assertInspectablePackage(bytes, format);
  // mammoth, SheetJS and the PPTX reader load with the first inspect, not with the Host's tool catalogue.
  if (format === 'docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    return JSON.stringify({
      format,
      characters: result.value.length,
      text: result.value.slice(0, 12000),
      warnings: result.messages.map((m) => m.message).slice(0, 8),
    });
  }
  if (format === 'xlsx') {
    const XLSX = await import('xlsx');
    const book = XLSX.read(bytes, { type: 'buffer', sheetRows: 31 });
    return JSON.stringify({
      format,
      sheets: book.SheetNames.map((name) => {
        const sheet = book.Sheets[name]!;
        const range = sheet['!fullref'] ?? sheet['!ref'];
        const bounds = range ? XLSX.utils.decode_range(range) : undefined;
        const sample = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }).slice(0, 30);
        const rows = bounds ? bounds.e.r - bounds.s.r + 1 : 0;
        return {
          name,
          range: range ?? null,
          rows,
          columns: bounds ? bounds.e.c - bounds.s.c + 1 : 0,
          sample,
          sampleTruncated: rows > sample.length,
        };
      }),
    }).slice(0, 20000);
  }
  const { readPptxSlides } = await import('./read.ts');
  const slides = await readPptxSlides(bytes);
  return JSON.stringify({ format, slideCount: slides.length, slides: slides.slice(0, 60) }).slice(
    0,
    20000,
  );
}
function changeFor(relative: string, operation: string): FileChange {
  return {
    path: relative,
    kind: 'create',
    patch: `Create Office file via ${operation}: ${relative}`,
    added: 0,
    removed: 0,
    truncated: false,
  };
}
async function sourceBytes(
  workspace: Workspace,
  input: string,
  format: OfficeFormat,
): Promise<{ file: string; bytes: Buffer }> {
  if (formatOf(input) !== format) throw new Error('Office source format does not match');
  const file = await workspace.resolve(input);
  const bytes = await readFile(file);
  if (!bytes.length || bytes.length > maximum)
    throw new Error('Office source must be 1 byte to 20 MB');
  return { file, bytes };
}
async function prepareWrite(
  root: string,
  args: Record<string, unknown>,
  operation: 'create' | 'edit' | 'preview',
  guidance: (directory: string) => string,
  renderer: OfficePreview,
): Promise<PreparedTool> {
  const workspace = new Workspace(root);
  const input = operation === 'create' ? String(args.path) : String(args.output_path);
  const output = await workspace.resolve(input, true);
  const relative = path.relative(workspace.root, output).split(path.sep).join('/');
  const format = operation === 'create' ? formatOf(input) : formatOf(String(args.source_path));
  if (operation === 'create' && args.format !== format)
    throw new Error('Office format and output extension differ');
  if (operation === 'create' && format === 'xlsx' && !args.sheets)
    throw new Error('Excel creation requires sheets');
  if (operation === 'create' && format === 'pptx' && !args.slides)
    throw new Error('PowerPoint creation requires slides');
  if (operation === 'edit' && format === 'xlsx' && !args.cells)
    throw new Error('Excel edit requires cells');
  if (operation === 'edit' && format !== 'xlsx' && !args.replacements)
    throw new Error('Word or PowerPoint edit requires replacements');
  const backend = (args.backend ?? 'auto') as PreviewBackend;
  if (operation === 'preview' && !PREVIEW_BACKENDS.includes(backend))
    throw new Error('Unknown Office preview backend');
  const allowed = operation === 'preview' ? previewExtensions(format, backend) : ['.' + format];
  const expected = path.extname(output).toLowerCase();
  if (!allowed.includes(expected))
    throw new Error(`Output must have ${allowed.join(' or ')} extension`);
  const instructions = guidance(path.dirname(output));
  if (instructions)
    throw new Error(
      'Read the applicable project instructions before retrying this change:\n' + instructions,
    );
  try {
    await lstat(output);
    throw new Error('Output already exists; choose a new path');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const original =
    operation === 'create'
      ? undefined
      : await sourceBytes(workspace, String(args.source_path), format);
  const change = changeFor(relative, operation);
  return {
    change,
    approvalDescription: `Creates ${relative}; source remains unchanged.`,
    async execute(ctx) {
      ctx.signal.throwIfAborted();
      await workspace.resolve(input, true);
      if (original) {
        const current = await sourceBytes(workspace, String(args.source_path), format);
        if (!current.bytes.equals(original.bytes))
          throw new Error('Office source changed since approval');
      }
      const temp = await mkdtemp(path.join(path.dirname(output), '.yuantu-office-'));
      const staged = path.join(temp, 'staged' + expected);
      try {
        let op: OfficeOperation | undefined;
        if (operation === 'create')
          op = {
            operation,
            format,
            outputPath: staged,
            title: args.title as string | undefined,
            paragraphs: args.paragraphs as string[] | undefined,
            blocks: args.blocks as Extract<OfficeOperation, { operation: 'create' }>['blocks'],
            sheets: args.sheets as Extract<OfficeOperation, { operation: 'create' }>['sheets'],
            slides: args.slides as Extract<OfficeOperation, { operation: 'create' }>['slides'],
          };
        else if (operation === 'edit')
          op = {
            operation,
            format,
            sourcePath: original!.file,
            outputPath: staged,
            replacements: args.replacements as Extract<
              OfficeOperation,
              { operation: 'edit' }
            >['replacements'],
            cells: args.cells as Extract<OfficeOperation, { operation: 'edit' }>['cells'],
          };
        let previewType: PreviewType | undefined;
        if (operation === 'preview') {
          const { renderPreview } = await import('./render.ts');
          previewType = await renderPreview(
            { format, sourcePath: original!.file, outputPath: staged, backend },
            renderer,
            ctx.signal,
          );
        } else await runOfficeAutomation(op!, ctx.signal);
        ctx.signal.throwIfAborted();
        const stagedBytes = await readFile(staged);
        if (!stagedBytes.length || stagedBytes.length > maximum)
          throw new Error('Office output must be 1 byte to 20 MB');
        await verifyFileDelivery(temp, { path: path.basename(staged) });
        if (operation !== 'preview') await inspect(staged, format);
        await workspace.resolve(input, true);
        if (original) {
          const current = await sourceBytes(workspace, String(args.source_path), format);
          if (!current.bytes.equals(original.bytes))
            throw new Error('Office source changed during processing');
        }
        const journalId = ctx.fileJournal?.prepare(change, null, stagedBytes);
        ctx.signal.throwIfAborted();
        await link(staged, output);
        if (journalId) ctx.fileJournal!.applied(journalId);
        const evidence = await verifyFileDelivery(root, { path: relative });
        return {
          isError: false,
          content: JSON.stringify({
            ...evidence,
            operation,
            previewType,
            previewWarnings:
              previewType === 'libreoffice-pdf'
                ? [
                    'Fonts and pagination may differ; inspect the PDF visually. Spreadsheet formula recalculation is not verified by a preview.',
                  ]
                : previewType === 'document-html'
                  ? [
                      'Built-in HTML preview: content and structure only; layout and fonts are approximate.',
                    ]
                  : undefined,
          }),
          change,
        };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 };
const replacements = {
  type: 'array',
  minItems: 1,
  maxItems: 200,
  items: {
    type: 'object',
    properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
};
const textTable = (maxRows: number) => ({
  type: 'array',
  minItems: 1,
  maxItems: maxRows,
  items: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_TABLE_COLUMNS,
    items: { type: 'string', maxLength: 2000 },
  },
});
const text = (maxLength: number) => ({ type: 'string', maxLength });
const block = (type: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: { type: { const: type }, ...properties },
  required: ['type', ...required],
  additionalProperties: false,
});
const blocks = {
  type: 'array',
  maxItems: MAX_DOCUMENT_BLOCKS,
  description:
    'Word body after title and paragraphs, in order. A table header row is bold unless header is false.',
  items: {
    anyOf: [
      block('heading', { text: text(500), level: { type: 'integer', enum: [1, 2, 3] } }, ['text']),
      block('paragraph', { text: text(10000) }, ['text']),
      block(
        'list',
        {
          items: { type: 'array', minItems: 1, maxItems: 100, items: text(2000) },
          ordered: { type: 'boolean' },
        },
        ['items'],
      ),
      block('table', { rows: textTable(MAX_TABLE_ROWS), header: { type: 'boolean' } }, ['rows']),
      block('page_break', {}, []),
    ],
  },
};
const cells = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: {
    type: 'object',
    properties: {
      sheet: { type: 'string', minLength: 1 },
      cell: { type: 'string', pattern: '^[A-Z]{1,3}[1-9][0-9]{0,5}$' },
      value: {
        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
      },
    },
    required: ['sheet', 'cell', 'value'],
    additionalProperties: false,
  },
};
export function officeTools(root: string, renderer: OfficePreview = libreOfficePreview): Tool[] {
  const known = new Set([loadInstructions(root).text]);
  const guidance = (directory: string): string => {
    const instructions = loadInstructions(root, directory).text;
    if (known.has(instructions)) return '';
    if (instructions.length > 18000)
      throw new Error('Scoped instructions exceed tool output budget');
    known.add(instructions);
    return instructions;
  };
  const writable = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    operation: 'create' | 'edit' | 'preview',
  ): Tool => ({
    name,
    description,
    permission: 'write',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    prepare: (args) => prepareWrite(root, args, operation, guidance, renderer),
    execute: async (args, ctx) =>
      (await prepareWrite(root, args, operation, guidance, renderer)).execute(ctx),
  });
  return [
    {
      name: 'office_inspect',
      isConcurrencySafe: parallelRead,
      description:
        'Read DOCX, XLSX or PPTX content and structure from a workspace file. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { path: pathSchema },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const file = await new Workspace(root).resolve(String(args.path));
        return { isError: false, content: await inspect(file, formatOf(file)) };
      },
    },
    writable(
      'office_create',
      'Create a Word, Excel or PowerPoint file in the workspace; works without Microsoft Office. Word: title, paragraphs, then blocks (headings, paragraphs, lists, tables, page breaks). PowerPoint: one entry per slide with bullets in body, an optional table (first row bold) and speaker notes; a slide with only a title is a section slide.',
      {
        format: { type: 'string', enum: formats },
        path: pathSchema,
        title: { type: 'string', maxLength: 500 },
        paragraphs: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 10000 } },
        blocks,
        sheets: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CREATED_SHEETS,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 31 },
              rows: {
                type: 'array',
                maxItems: 1000,
                items: {
                  type: 'array',
                  maxItems: 100,
                  items: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' },
                    ],
                  },
                },
              },
            },
            required: ['name', 'rows'],
            additionalProperties: false,
          },
        },
        slides: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 500 },
              body: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 5000 } },
              table: textTable(MAX_SLIDE_TABLE_ROWS),
              notes: { type: 'string', maxLength: 10000 },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      ['format', 'path'],
      'create',
    ),
    writable(
      'office_edit',
      'Create a revised Office file from a template, preserving unaffected document structure and formatting; works without Microsoft Office. DOCX/PPTX replace every occurrence of each text (also across formatting runs; the replacement takes the formatting where the match starts); XLSX updates existing cells.',
      { source_path: pathSchema, output_path: pathSchema, replacements, cells },
      ['source_path', 'output_path'],
      'edit',
    ),
    writable(
      'office_preview',
      'Create a preview without changing the source. The output extension picks the kind: .html is a built-in preview that needs nothing installed (Word text and tables, slide text, Excel cell values); .pdf uses local Microsoft Office for Word/PowerPoint and falls back to LibreOffice. backend forces one engine (html, office, libreoffice). Visual fidelity and formula calculation need separate verification.',
      {
        source_path: pathSchema,
        output_path: pathSchema,
        backend: { type: 'string', enum: [...PREVIEW_BACKENDS] },
      },
      ['source_path', 'output_path'],
      'preview',
    ),
  ];
}
