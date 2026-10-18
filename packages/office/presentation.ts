import { writeFile } from 'node:fs/promises';
import pptxgenjs from 'pptxgenjs';
import type { OfficeOperation } from './automation.ts';
import { MAX_SLIDE_TABLE_ROWS, MAX_TABLE_COLUMNS } from './limits.ts';
import { xmlText } from './xml-text.ts';

/**
 * The package's types declare an ES default export over a CommonJS entry, so under NodeNext resolution the
 * default import is typed as the module namespace while at runtime it is the class itself.
 */
const PptxGenJS = pptxgenjs as unknown as typeof pptxgenjs.default;
type Deck = InstanceType<typeof PptxGenJS>;

/** Declared in `limits.ts` so the tool schema can read it without loading `pptxgenjs`. */
export { MAX_SLIDE_TABLE_ROWS };

export type SlideSpec = { title: string; body?: string[]; table?: string[][]; notes?: string };

/** Slide geometry in inches on the 13.33" × 7.5" widescreen layout. */
const MARGIN = 0.5;
const WIDTH = 13.333 - 2 * MARGIN;
const TITLE = { x: MARGIN, y: 0.35, w: WIDTH, h: 1.0 };
const CONTENT_TOP = 1.5;
const CONTENT_HEIGHT = 7.5 - CONTENT_TOP - MARGIN;
const GAP = 0.2;

/**
 * Font sizes to try, largest first. The file is laid out here, at a size the text is estimated to fit:
 * `fit: 'shrink'` only marks a box for autofit, and PowerPoint does not apply it until someone edits the text, so
 * left to it a long list opens spilling past the slide.
 */
const BULLET_SIZES = [20, 18, 16, 14, 12];
const TABLE_SIZES = [14, 12, 11, 10];
/** Line height as a multiple of the font size, PowerPoint's single spacing. */
const LINE = 1.2;
/** pptxgenjs defaults: text box insets, bullet indent and cell margins, in inches. */
const BOX_INSET_X = 0.2;
const BOX_INSET_Y = 0.1;
const BULLET_INDENT = 27 / 72;
const CELL_MARGIN_X = 0.2;
const CELL_MARGIN_Y = 0.1;

/**
 * How wide a string sets, in inches: a CJK or other wide character takes a full em, anything else a little over
 * half of one. Deliberately generous, since overestimating only costs a point of font size.
 */
function textWidth(text: string, size: number): number {
  let ems = 0;
  for (const character of text) ems += character.codePointAt(0)! >= 0x2e80 ? 1 : 0.55;
  return (ems * size) / 72;
}
function lineCount(text: string, size: number, width: number): number {
  return text
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidth(line, size) / width)), 0);
}
const lineHeight = (size: number): number => (size * LINE) / 72;

function bulletsHeight(body: string[], size: number): number {
  const width = WIDTH - BOX_INSET_X - BULLET_INDENT;
  const lines = body.reduce((sum, text) => sum + lineCount(text, size, width), 0);
  return lines * lineHeight(size) + BOX_INSET_Y;
}
/** Each row as tall as its most-wrapped cell, so the heights written into the file are the heights drawn. */
function rowHeights(rows: string[][], columns: number, size: number): number[] {
  const width = WIDTH / columns - CELL_MARGIN_X;
  return rows.map(
    (row) =>
      Math.max(1, ...row.map((text) => lineCount(text, size, width))) * lineHeight(size) +
      CELL_MARGIN_Y,
  );
}
const total = (heights: number[]): number => heights.reduce((sum, height) => sum + height, 0);

function addSlide(deck: Deck, spec: SlideSpec, index: number): void {
  const slide = deck.addSlide();
  const body = (spec.body ?? []).map(xmlText);
  const rows = (spec.table ?? []).map((row) => row.map(xmlText));
  const content = body.length > 0 || rows.length > 0;
  // A slide with nothing under its title is a section slide: centre the title instead of pinning it to the top.
  slide.addText(
    xmlText(spec.title),
    content
      ? { ...TITLE, fontSize: 30, bold: true, valign: 'middle' }
      : { x: MARGIN, y: 2.5, w: WIDTH, h: 2.0, fontSize: 40, bold: true, align: 'center' },
  );
  let columns = 0;
  if (rows.length) {
    if (rows.length > MAX_SLIDE_TABLE_ROWS)
      throw new Error(`PowerPoint table must have 1 to ${MAX_SLIDE_TABLE_ROWS} rows`);
    columns = Math.max(...rows.map((row) => row.length));
    if (columns < 1 || columns > MAX_TABLE_COLUMNS)
      throw new Error(`PowerPoint table must have 1 to ${MAX_TABLE_COLUMNS} columns`);
  }
  // The table is placed first, at its smallest size, because a table that does not fit cannot shrink into
  // shape the way a bullet list can; bullets take what is left above it.
  const smallestTable = rows.length
    ? total(rowHeights(rows, columns, TABLE_SIZES.at(-1)!)) + (body.length ? GAP : 0)
    : 0;
  if (smallestTable > CONTENT_HEIGHT)
    throw new Error(
      `Slide ${index + 1}: the table is too long to fit one slide; split it across slides or shorten its cells`,
    );
  const bulletRoom = CONTENT_HEIGHT - smallestTable;
  let bulletBox = 0;
  if (body.length) {
    const size = BULLET_SIZES.find((candidate) => bulletsHeight(body, candidate) <= bulletRoom);
    // A list too long for any size still gets the whole content area on a slide of its own, marked for
    // autofit; above a table it would run into the table, so that is refused instead.
    if (size === undefined && rows.length)
      throw new Error(
        `Slide ${index + 1}: the bullets and the table do not fit one slide together; put them on separate slides`,
      );
    const fontSize = size ?? BULLET_SIZES.at(-1)!;
    bulletBox = rows.length ? bulletsHeight(body, fontSize) : CONTENT_HEIGHT;
    slide.addText(
      body.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      {
        x: MARGIN,
        y: CONTENT_TOP,
        w: WIDTH,
        h: bulletBox,
        fontSize,
        valign: 'top',
        fit: 'shrink',
      },
    );
  }
  if (rows.length) {
    const top = CONTENT_TOP + (body.length ? bulletBox + GAP : 0);
    const room = CONTENT_TOP + CONTENT_HEIGHT - top;
    const fontSize =
      TABLE_SIZES.find((candidate) => total(rowHeights(rows, columns, candidate)) <= room) ??
      TABLE_SIZES.at(-1)!;
    slide.addTable(
      rows.map((row, rowIndex) =>
        [...row, ...Array<string>(columns - row.length).fill('')].map((text) => ({
          text,
          options: rowIndex === 0 ? { bold: true, fill: { color: 'E7E6E6' } } : {},
        })),
      ),
      {
        x: MARGIN,
        y: top,
        w: WIDTH,
        rowH: rowHeights(rows, columns, fontSize),
        fontSize,
        border: { type: 'solid', pt: 0.5, color: '999999' },
        autoPage: false,
      },
    );
  }
  if (spec.notes) slide.addNotes(xmlText(spec.notes));
}

/** Builds a PowerPoint deck in-process, so creating PPTX needs neither Microsoft Office nor PowerShell. */
export async function createPptx(
  operation: Extract<OfficeOperation, { operation: 'create' }>,
): Promise<void> {
  const slides = operation.slides ?? [];
  if (!slides.length) throw new Error('PowerPoint creation requires slides');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  if (operation.title) deck.title = xmlText(operation.title);
  slides.forEach((spec, index) => addSlide(deck, spec, index));
  const bytes = await deck.write({ outputType: 'nodebuffer' });
  await writeFile(operation.outputPath, bytes as Uint8Array);
}
