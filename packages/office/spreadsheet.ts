import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { OfficeOperation } from './automation.ts';
import { MAX_CREATED_SHEETS } from './limits.ts';
import { previewStyleLink, previewText, type PreviewLanguage } from './preview-page.ts';
import { readEntry } from './zip-entry.ts';

/**
 * Per-part ceilings, in uncompressed bytes.
 *
 * The workbook and relationship parts are index files and are kilobytes in anything real; a worksheet is the one
 * part that legitimately grows, and 10 MB is already a very large sheet. All three are applied while the part is
 * read, so none of them depends on the package telling the truth about its own contents.
 */
const WORKBOOK_XML_BYTES = 2_000_000;
const RELATIONSHIP_XML_BYTES = 1_000_000;
const WORKSHEET_XML_BYTES = 10_000_000;

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!,
  );
}
function xmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"'))?.[1];
}
async function editWorkbook(
  sourcePath: string,
  outputPath: string,
  cells: NonNullable<Extract<OfficeOperation, { operation: 'edit' }>['cells']>,
): Promise<void> {
  const source = await readFile(sourcePath);
  if (source.length > 20_000_000) throw new Error('Excel template exceeds 20 MB');
  const zip = await JSZip.loadAsync(source);
  const workbook = await readEntry(
    zip.file('xl/workbook.xml'),
    WORKBOOK_XML_BYTES,
    'Excel workbook XML',
  );
  const rels = await readEntry(
    zip.file('xl/_rels/workbook.xml.rels'),
    RELATIONSHIP_XML_BYTES,
    'Excel relationship XML',
  );
  if (!workbook || !rels) throw new Error('Invalid XLSX workbook relationships');
  const targets = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*\/?\s*>/g) ?? []) {
    const id = xmlAttribute(tag, 'Id'),
      target = xmlAttribute(tag, 'Target');
    if (id && target) targets.set(id, target);
  }
  const sheets = new Map<string, string>();
  for (const tag of workbook.match(/<sheet\b[^>]*\/?\s*>/g) ?? []) {
    const name = xmlAttribute(tag, 'name'),
      id = xmlAttribute(tag, 'r:id');
    if (!name || !id || !targets.has(id)) continue;
    const target = targets.get(id)!;
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
    if (file.startsWith('xl/worksheets/')) sheets.set(name, file);
  }
  for (const sheetName of [...new Set(cells.map((cell) => cell.sheet))]) {
    const file = sheets.get(sheetName);
    if (!file) throw new Error('Excel sheet not found: ' + sheetName);
    let xml = await readEntry(zip.file(file), WORKSHEET_XML_BYTES, 'Excel worksheet');
    if (!xml) throw new Error('Excel worksheet is missing');
    for (const change of cells.filter((cell) => cell.sheet === sheetName)) {
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,5}$/.test(change.cell))
        throw new Error('Invalid Excel cell reference');
      let found = false;
      // The self-closing branch must come first: with a single alternation group the greedy
      // `[^>]*` swallows the `/` of a self-closing tag, the `\/>` branch fails, and the engine
      // falls through to `>[\s\S]*?<\/c>` — which spans into the *next* cell and deletes it when
      // the match is replaced. Ordered branches let the engine backtrack into the right one.
      xml = xml.replace(/<c\b[^>]*?\/>|<c\b[^>]*?>[\s\S]*?<\/c>/g, (element) => {
        const open = element.match(/^<c\b[^>]*?(?:\/?>)/)![0];
        if (xmlAttribute(open, 'r') !== change.cell) return element;
        if (found) throw new Error('Duplicate Excel cell reference');
        found = true;
        const attrs = open
          .slice(2)
          .replace(/\/?>$/, '')
          .replace(/\s+t="[^"]*"/, '');
        if (change.value === null) return '<c' + attrs + '/>';
        if (typeof change.value === 'number') {
          if (!Number.isFinite(change.value)) throw new Error('Invalid Excel number');
          return '<c' + attrs + '><v>' + change.value + '</v></c>';
        }
        if (typeof change.value === 'boolean')
          return '<c' + attrs + ' t="b"><v>' + (change.value ? 1 : 0) + '</v></c>';
        return (
          '<c' +
          attrs +
          ' t="inlineStr"><is><t xml:space="preserve">' +
          escapeXml(change.value) +
          '</t></is></c>'
        );
      });
      if (!found) throw new Error('Excel cell does not exist in template: ' + change.cell);
    }
    zip.file(file, xml);
  }
  await writeFile(
    outputPath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
}
/**
 * How many sheets one `office_create` call may build, declared once because two readers ask.
 *
 * The engine refuses more, and the tool schema is what the model is offered: when the two numbers were typed
 * separately the schema advertised 30 while the engine stopped at 20, so a call with 25 sheets validated and
 * then failed — a request the tool could describe but never satisfy. The schema therefore derives its bound
 * from this constant rather than repeating it, which is the same rule `RUN_DEFAULTS` and `ENVIRONMENT` follow.
 */
export { MAX_CREATED_SHEETS };
/** A created cell that starts with `=` is a formula, not text — the shape a spreadsheet author expects. */
function isFormula(value: string | number | boolean | null): value is string {
  return typeof value === 'string' && value.length > 1 && value.startsWith('=');
}
export async function runSpreadsheetOperation(
  operation: OfficeOperation & { format: 'xlsx' },
): Promise<void> {
  if (operation.operation === 'create') {
    const sheets = operation.sheets ?? [];
    if (!sheets.length || sheets.length > MAX_CREATED_SHEETS)
      throw new Error(`Provide 1 to ${MAX_CREATED_SHEETS} Excel sheets`);
    const book = XLSX.utils.book_new();
    for (const sheet of sheets) {
      if (!sheet.name || sheet.name.length > 31 || !sheet.rows.length || sheet.rows.length > 1000)
        throw new Error('Invalid Excel sheet');
      const table = XLSX.utils.aoa_to_sheet(
        sheet.rows.map((row) => row.map((value) => (isFormula(value) ? null : value))),
      );
      sheet.rows.forEach((row, r) =>
        row.forEach((value, c) => {
          if (!isFormula(value)) return;
          const address = XLSX.utils.encode_cell({ r, c });
          /*
           * A formula cell carries no cached value, because no calculation engine is bundled: Excel, WPS and
           * LibreOffice compute it when the workbook opens. Before this, `office_create` wrote `=SUM(B2:B3)` as
           * literal text, and a model asked for "a total column" had to leave the tool and patch the file with
           * Python/openpyxl — what turned a one-sheet summary into 30+ steps and 700K tokens in a real run.
           *
           * The cell is an object without `t`: writing `{ t: 'n', f }` made this writer emit `t="e"` (an error
           * cell) for every formula, which is worse than the text it replaced.
           */
          table[address] = { f: value.slice(1) } as XLSX.CellObject;
        }),
      );
      XLSX.utils.book_append_sheet(book, table, sheet.name);
    }
    await writeFile(
      operation.outputPath,
      XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }),
    );
  } else if (operation.operation === 'edit') {
    if (!operation.cells?.length || operation.cells.length > 100)
      throw new Error('Provide 1 to 100 Excel cell edits');
    await editWorkbook(operation.sourcePath, operation.outputPath, operation.cells);
  } else {
    await writeFile(
      operation.outputPath,
      await spreadsheetPreviewHtml(operation.sourcePath),
      'utf8',
    );
  }
}
/**
 * The workbook as a self-contained HTML page.
 *
 * Extracted from the preview operation so the workspace panel can show a workbook without writing a file next
 * to it: the page is escaped here, carries no script, and is drawn in a sandboxed frame by the window. Cells are
 * read one by one rather than through `sheet_to_json`: that reader trims a row at its last value and drops a
 * formula-only cell, which turned a totals row into an empty row in the in-app preview.
 */
export async function spreadsheetPreviewHtml(
  sourcePath: string,
  language: PreviewLanguage = 'zh',
): Promise<string> {
  const bytes = await readFile(sourcePath);
  if (bytes.length > 20_000_000) throw new Error('Excel preview source exceeds 20 MB');
  const book = XLSX.read(bytes, {
    type: 'buffer',
    sheetRows: 100,
    cellHTML: false,
    // Keep a cell that has only a formula; without this SheetJS drops the cell before the page can show it.
    sheetStubs: true,
  });
  const sheets = book.SheetNames.slice(0, 20).map((name) => {
    const sheet = book.Sheets[name]!;
    const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : undefined;
    const rows: { text: string; formula: boolean }[][] = [];
    if (range) {
      const lastRow = Math.min(range.e.r, range.s.r + 99);
      const lastColumn = Math.min(range.e.c, range.s.c + 19);
      for (let row = range.s.r; row <= lastRow; row++) {
        const cells: { text: string; formula: boolean }[] = [];
        for (let column = range.s.c; column <= lastColumn; column++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          const formula = typeof cell?.f === 'string' ? cell.f : undefined;
          cells.push({
            // Showing the formula is the honest reading when no calculation engine has produced a cached value;
            // the page says so, rather than drawing an empty cell that looks like a missing total.
            text: formula ? `=${formula}` : String(cell?.w ?? cell?.v ?? ''),
            formula: formula !== undefined,
          });
        }
        rows.push(cells);
      }
    }
    return { name, rows };
  });
  const escaped = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    );
  const hasFormula = sheets.some((sheet) =>
    sheet.rows.some((row) => row.some((cell) => cell.formula)),
  );
  const body = sheets
    .map(
      (sheet) =>
        '<section><h2>' +
        escaped(sheet.name) +
        '</h2><table>' +
        sheet.rows
          .map(
            (row) =>
              '<tr>' +
              row
                .map(
                  (cell) =>
                    `<td${cell.formula ? ' class="formula"' : ''}>` + escaped(cell.text) + '</td>',
                )
                .join('') +
              '</tr>',
          )
          .join('') +
        '</table></section>',
    )
    .join('');
  const css =
    'body{font:14px/1.6 system-ui,sans-serif;margin:32px;color:#222}' +
    'table{border-collapse:collapse;max-width:100%;margin:0 0 24px}' +
    'td{border:1px solid #bbb;padding:6px 10px;white-space:pre-wrap;vertical-align:top}' +
    'td.formula{color:#7a4b00;background:#fff8e6;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}' +
    'h2{margin:28px 0 8px}.note{color:#666;font-size:13px;margin:0 0 20px}';
  const title = previewText(language, 'Excel 数据预览', 'Excel data preview');
  const note = previewText(
    language,
    '仅显示单元格值；不还原源文件格式。',
    'Cell values only; source workbook formatting is not reproduced.',
  );
  const formulaNote = hasFormula
    ? '<p class="note">' +
      previewText(
        language,
        '含公式的单元格显示为公式文本，数值需在 Excel 中计算。',
        'Formula cells are shown as formulas; values are calculated when the workbook is opened in Excel.',
      ) +
      '</p>'
    : '';
  return (
    `<!doctype html><html lang="${language === 'en' ? 'en' : 'zh-CN'}"><meta charset="utf-8">` +
    `<title>${escaped(title)}</title>` +
    previewStyleLink(css) +
    `<h1>${escaped(title)}</h1><p class="note">${escaped(note)}</p>` +
    formulaNote +
    body +
    '</html>'
  );
}
