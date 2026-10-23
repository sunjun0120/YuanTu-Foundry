import { readFile } from 'node:fs/promises';
import type { OfficeFormat } from './automation.ts';
import { assertExpansionWithinBudget } from './zip-entry.ts';

/** The largest Office file any tool reads or writes, compressed. */
export const MAX_OFFICE_BYTES = 20_000_000;
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
/**
 * Read an Office file's text and structure, in whatever thread calls it.
 *
 * The Host calls it through `inspectInWorker` (`./inspect-runner.ts`) and never directly: the parsers are not this
 * repository's, they consult no CPU budget, and a hostile package can make them spin or allocate far past what its
 * size suggests. Run on the Host's event loop that stalled every session; run in a worker it costs one thread.
 */
export async function inspectOffice(file: string, format: OfficeFormat): Promise<string> {
  const bytes = await readFile(file);
  if (!bytes.length || bytes.length > MAX_OFFICE_BYTES)
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
    // `sheetStubs` keeps a cell that holds only a formula: without it the reader drops `=SUM(B2:B3)` entirely
    // and the inspection reports a total row that does not exist. The cached `v` of such a cell is 0, so the
    // sample below prints the formula itself rather than that fabricated zero.
    const book = XLSX.read(bytes, { type: 'buffer', sheetRows: 31, sheetStubs: true });
    return JSON.stringify({
      format,
      sheets: book.SheetNames.map((name) => {
        const sheet = book.Sheets[name]!;
        const range = sheet['!fullref'] ?? sheet['!ref'];
        const bounds = range ? XLSX.utils.decode_range(range) : undefined;
        // Built cell by cell rather than through `sheet_to_json`: that reader trims a row at its last value,
        // and a row whose tail is formulas (a totals row) would lose exactly the cells a reader wants to see.
        const sample: unknown[][] = [];
        if (bounds) {
          const lastRow = Math.min(bounds.e.r, bounds.s.r + 29);
          for (let row = bounds.s.r; row <= lastRow; row++) {
            const values: unknown[] = [];
            for (let column = bounds.s.c; column <= bounds.e.c; column++) {
              const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
              // A formula has no cached result here, so its fabricated stub value (0) is never shown.
              values.push(
                typeof cell?.f === 'string' ? '=' + cell.f : (cell?.w ?? cell?.v ?? null),
              );
            }
            sample.push(values);
          }
        }
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
