import { writeFile } from 'node:fs/promises';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { OfficeOperation } from './automation.ts';
import { MAX_DOCUMENT_BLOCKS, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from './limits.ts';
import { xmlText } from './xml-text.ts';

export type DocumentBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; rows: string[][]; header?: boolean }
  | { type: 'page_break' };

/** Declared in `limits.ts` so the tool schema can read them without loading `docx`. */
export { MAX_DOCUMENT_BLOCKS, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS };

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;
const ORDERED = 'ordered-list';

/** A run per line, so a newline in model text becomes a line break instead of vanishing. */
function runs(text: string, bold = false): TextRun[] {
  return xmlText(text)
    .split(/\r?\n/)
    .map((line, index) => new TextRun({ text: line, bold, break: index ? 1 : undefined }));
}

function table(block: Extract<DocumentBlock, { type: 'table' }>): Table {
  if (!block.rows.length || block.rows.length > MAX_TABLE_ROWS)
    throw new Error(`Word table must have 1 to ${MAX_TABLE_ROWS} rows`);
  const columns = Math.max(...block.rows.map((row) => row.length));
  if (columns < 1 || columns > MAX_TABLE_COLUMNS)
    throw new Error(`Word table must have 1 to ${MAX_TABLE_COLUMNS} columns`);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: block.rows.map((row, index) => {
      const header = index === 0 && block.header !== false;
      // Short rows are padded so every row spans the table; Word renders ragged rows as broken grids.
      const cells = [...row, ...Array<string>(columns - row.length).fill('')];
      return new TableRow({
        tableHeader: header,
        children: cells.map(
          (cell) => new TableCell({ children: [new Paragraph({ children: runs(cell, header) })] }),
        ),
      });
    }),
  });
}

function render(block: DocumentBlock, nextList: () => number): (Paragraph | Table)[] {
  switch (block.type) {
    case 'heading':
      return [new Paragraph({ heading: HEADINGS[block.level ?? 1], children: runs(block.text) })];
    case 'paragraph':
      return [new Paragraph({ children: runs(block.text) })];
    case 'list': {
      // Every ordered list shares one numbering definition but gets its own instance of it, so each counts from
      // 1; paragraphs that name only the reference all join one instance, and a second list would carry on.
      const instance = block.ordered ? nextList() : 0;
      return block.items.map(
        (item) =>
          new Paragraph({
            children: runs(item),
            ...(block.ordered
              ? { numbering: { reference: ORDERED, level: 0, instance } }
              : { bullet: { level: 0 } }),
          }),
      );
    }
    case 'table':
      // An empty paragraph after a table keeps the next table or heading from fusing into it.
      return [table(block), new Paragraph({})];
    case 'page_break':
      return [new Paragraph({ children: [new PageBreak()] })];
  }
}

/**
 * Builds a Word document in-process, so creating DOCX needs neither Microsoft Office nor PowerShell.
 *
 * `title` and `paragraphs` keep the meaning they had under the COM path — a Title-styled first line, then
 * Normal paragraphs — and `blocks` follow them in order.
 */
export async function createDocx(
  operation: Extract<OfficeOperation, { operation: 'create' }>,
): Promise<void> {
  const blocks = operation.blocks ?? [];
  if (blocks.length > MAX_DOCUMENT_BLOCKS)
    throw new Error(`Word documents accept at most ${MAX_DOCUMENT_BLOCKS} blocks`);
  const children: (Paragraph | Table)[] = [];
  if (operation.title)
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(operation.title) }));
  for (const text of operation.paragraphs ?? [])
    children.push(new Paragraph({ children: runs(text) }));
  let lists = 0;
  for (const block of blocks) children.push(...render(block, () => ++lists));
  if (!children.length) children.push(new Paragraph({}));
  const document = new Document({
    title: operation.title === undefined ? undefined : xmlText(operation.title),
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  await writeFile(operation.outputPath, await Packer.toBuffer(document));
}
