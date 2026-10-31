import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { previewStyleLink, previewText, type PreviewLanguage } from './preview-page.ts';

/**
 * The workbook as a self-contained HTML page, for the workspace panel.
 *
 * The page is escaped here, carries no script, and is drawn in a sandboxed frame by the window. Cells are
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
