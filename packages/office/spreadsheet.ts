import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { OfficeOperation } from './automation.ts';

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
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
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
    let xml = await zip.file(file)?.async('string');
    if (!xml || xml.length > 10_000_000) throw new Error('Excel worksheet is missing or too large');
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
export async function runSpreadsheetOperation(
  operation: OfficeOperation & { format: 'xlsx' },
): Promise<void> {
  if (operation.operation === 'create') {
    const sheets = operation.sheets ?? [];
    if (!sheets.length || sheets.length > 20) throw new Error('Provide 1 to 20 Excel sheets');
    const book = XLSX.utils.book_new();
    for (const sheet of sheets) {
      if (!sheet.name || sheet.name.length > 31 || !sheet.rows.length || sheet.rows.length > 1000)
        throw new Error('Invalid Excel sheet');
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
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
    const bytes = await readFile(operation.sourcePath);
    if (bytes.length > 20_000_000) throw new Error('Excel preview source exceeds 20 MB');
    const book = XLSX.read(bytes, { type: 'buffer', sheetRows: 100, cellHTML: false });
    const sheets = book.SheetNames.slice(0, 20).map((name) => ({
      name,
      rows: (
        XLSX.utils.sheet_to_json(book.Sheets[name]!, {
          header: 1,
          raw: false,
          defval: '',
        }) as unknown[][]
      )
        .slice(0, 100)
        .map((row) => row.slice(0, 20).map(String)),
    }));
    const escaped = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (character) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
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
                '<tr>' + row.map((cell) => '<td>' + escaped(cell) + '</td>').join('') + '</tr>',
            )
            .join('') +
          '</table></section>',
      )
      .join('');
    await writeFile(
      operation.outputPath,
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Excel data preview</title>' +
        '<style>body{font:14px system-ui;margin:32px;color:#222}table{border-collapse:collapse;max-width:100%;margin-bottom:24px}td{border:1px solid #bbb;padding:6px 10px;white-space:pre-wrap}h2{margin-top:28px}</style>' +
        '<h1>Excel data preview</h1><p>Cell values only; source workbook formatting is not reproduced.</p>' +
        body +
        '</html>',
      'utf8',
    );
  }
}
