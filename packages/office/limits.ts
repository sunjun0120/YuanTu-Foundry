/**
 * The bounds the Office tool schemas advertise and the generators enforce, kept apart from the generators.
 *
 * The tool catalogue is built at Host start and needs these numbers for its schemas; the generators need `docx`,
 * `pptxgenjs` and SheetJS, which are the heaviest imports in the Host. Declaring the bounds here lets the catalogue
 * describe the tools without loading any of that until a call actually creates or reads a file.
 */

/**
 * How many blocks and table cells one `office_create` call may hand the Word generator, declared once because
 * the tool schema and the generator both enforce them.
 */
export const MAX_DOCUMENT_BLOCKS = 400;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 20;

/**
 * Rows one slide table may hold. Fifteen rows fit the content area at 14 pt, and still leave room for a few
 * bullets at the smallest table size; a longer table belongs on several slides or in a workbook.
 */
export const MAX_SLIDE_TABLE_ROWS = 15;

/** Sheets one `office_create` call may produce; see `spreadsheet.ts` for why the schema derives from it. */
export const MAX_CREATED_SHEETS = 20;
