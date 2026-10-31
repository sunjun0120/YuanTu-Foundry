/** Small Office files for the read-only preview and attachment tests, made with the libraries a script would use. */
import { writeFile } from 'node:fs/promises';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import pptxgenjs from 'pptxgenjs';
import * as XLSX from 'xlsx';

/** Under NodeNext the default import is the module namespace, so the class is its `default`. */
const PptxGenJS = pptxgenjs as unknown as typeof pptxgenjs.default;

/** A Word document: a title, the paragraphs in order, then a table when rows are given. */
export async function writeDocx(
  file: string,
  { title, paragraphs = [], table }: { title?: string; paragraphs?: string[]; table?: string[][] },
): Promise<void> {
  const children: (Paragraph | Table)[] = [];
  if (title) children.push(new Paragraph(title));
  for (const text of paragraphs) children.push(new Paragraph(text));
  if (table)
    children.push(
      new Table({
        rows: table.map(
          (row) =>
            new TableRow({
              children: row.map((text) => new TableCell({ children: [new Paragraph(text)] })),
            }),
        ),
      }),
    );
  await writeFile(file, await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

/** A deck with one slide per entry, each holding that entry's text. */
export async function writePptx(file: string, slides: string[]): Promise<void> {
  const deck = new PptxGenJS();
  for (const text of slides) deck.addSlide().addText(text, { x: 0.5, y: 0.5, w: 9, h: 1 });
  await writeFile(file, (await deck.write({ outputType: 'nodebuffer' })) as Buffer);
}

/**
 * A workbook with one sheet; a cell starting with `=` is written as a formula with no cached value.
 *
 * The formula cell is an object without `t`: `{ t: 'n', f }` makes this writer emit `t="e"`, an error cell.
 */
export async function writeXlsx(
  file: string,
  rows: (string | number)[][],
  sheet = 'Sheet1',
): Promise<void> {
  const formula = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 1 && value.startsWith('=');
  const table = XLSX.utils.aoa_to_sheet(
    rows.map((row) => row.map((value) => (formula(value) ? null : value))),
  );
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (formula(value))
        table[XLSX.utils.encode_cell({ r, c })] = { f: value.slice(1) } as XLSX.CellObject;
    }),
  );
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, table, sheet);
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
}
