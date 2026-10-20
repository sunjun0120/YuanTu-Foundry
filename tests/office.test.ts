import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { readPptxSlides } from '../packages/office/read.ts';
import {
  OfficeUnavailableError,
  isOfficeUnavailable,
  isScriptAuthorizationFailure,
  runOfficeAutomation,
} from '../packages/office/automation.ts';
import { verifyFileDelivery, deliveryFormats } from '../packages/tools/file-delivery.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { officeTools } from '../packages/office/tools.ts';
import { MAX_CREATED_SHEETS, runSpreadsheetOperation } from '../packages/office/spreadsheet.ts';
import { MAX_DOCUMENT_BLOCKS, MAX_TABLE_COLUMNS } from '../packages/office/document.ts';
import { MAX_SLIDE_TABLE_ROWS } from '../packages/office/presentation.ts';
import { deliveryTool } from '../packages/tools/delivery.ts';
import { tempRoot } from './temp-fixture.ts';

// ---- merged from office.test.ts ----

test('a missing Office install is recognised from the localized COM error', () => {
  // Captured from a Chinese Windows; the wording is localized, the HRESULT is not.
  assert.equal(
    isOfficeUnavailable(
      '检索 COM 类工厂中 CLSID 为 {00000000-0000-0000-0000-000000000000} 的组件失败，原因是出现以下错误: ' +
        '80040154 Class not registered (异常来自 HRESULT:0x80040154 (REGDB_E_CLASSNOTREG))。',
    ),
    true,
  );
  assert.equal(
    isOfficeUnavailable(
      'Retrieving the COM class factory for component with CLSID {000209FF-0000-0000-C000-000000000046} ' +
        'failed due to the following error: 80040154 Class not registered (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).',
    ),
    true,
  );
  // Other failures must not be mistaken for a missing install.
  assert.equal(isOfficeUnavailable('Word text not found: marker 947'), false);
  assert.equal(isOfficeUnavailable(''), false);
  assert.equal(isOfficeUnavailable('Office operation failed: 0x800A01A8'), false);
});

test('a refused script is recognised apart from a missing Office install', () => {
  // Captured verbatim by running the shipped `automation.ps1` on a machine whose integrity label makes
  // Windows refuse the file. The script never ran, so this says nothing about whether Office is installed.
  const refused =
    'AuthorizationManager check failed.\n' +
    '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException\n' +
    '    + FullyQualifiedErrorId : UnauthorizedAccess\n';
  assert.equal(isScriptAuthorizationFailure(refused), true);
  assert.equal(
    isOfficeUnavailable(refused),
    false,
    'a refused script must not be reported as a missing installation',
  );
  // The other shape the same refusal takes: an execution policy that will not run unsigned files.
  assert.equal(
    isScriptAuthorizationFailure(
      'automation.ps1 cannot be loaded because it is not digitally signed.\n' +
        '    + CategoryInfo : SecurityError: (:) [], PSSecurityException\n' +
        '    + FullyQualifiedErrorId : UnauthorizedAccess\n',
    ),
    true,
  );
  // And the two must not swallow each other's cause.
  assert.equal(isScriptAuthorizationFailure('80040154 Class not registered'), false);
  assert.equal(isScriptAuthorizationFailure('Word text not found: marker 947'), false);
  assert.equal(isScriptAuthorizationFailure(''), false);
});

test('operation text containing authorization keywords is not a script refusal', () => {
  for (const keyword of ['AuthorizationManager', 'UnauthorizedAccess', 'PSSecurityException']) {
    for (const app of ['Word', 'PowerPoint']) {
      assert.equal(
        isScriptAuthorizationFailure(
          `${app} text not found: ${keyword} | at <ScriptBlock>, automation.ps1: line 37`,
        ),
        false,
        `${app} replacement text: ${keyword}`,
      );
    }
  }
  assert.equal(isScriptAuthorizationFailure('UnauthorizedAccess'), false);
  assert.equal(
    isScriptAuthorizationFailure('    + FullyQualifiedErrorId : UnauthorizedAccess\n'),
    false,
    'a general access error alone does not prove script loading was refused',
  );
});

/**
 * The Excel path is pure JavaScript, so it runs on every platform without
 * Office. Only Word and PowerPoint editing and PDF previews need local Office
 * (tests/office-native.test.ts), and a machine without it skips there with a reason.
 */
test(
  'Excel creation, template edit and HTML preview preserve unaffected workbook parts',
  { timeout: 60000 },
  async (t) => {
    const root = await tempRoot(t, 'yuantu-excel-workflow-');
    const sheet = path.join(root, 'source.xlsx');
    const changed = path.join(root, 'changed.xlsx');
    await runOfficeAutomation({
      operation: 'create',
      format: 'xlsx',
      outputPath: sheet,
      sheets: [
        {
          name: 'Results',
          rows: [
            ['Metric', 'Value'],
            ['Revenue', 947],
          ],
        },
      ],
    });
    await runOfficeAutomation({
      operation: 'edit',
      format: 'xlsx',
      sourcePath: sheet,
      outputPath: changed,
      cells: [{ sheet: 'Results', cell: 'B2', value: 948 }],
    });
    await runOfficeAutomation({
      operation: 'preview',
      format: 'xlsx',
      sourcePath: changed,
      outputPath: path.join(root, 'sheet.html'),
    });
    const book = XLSX.read(await readFile(changed), { type: 'buffer' });
    assert.equal(book.Sheets.Results?.A2?.v, 'Revenue');
    assert.equal(book.Sheets.Results?.B2?.v, 948);
    // Untouched parts must survive the targeted edit byte for byte.
    const beforeZip = await JSZip.loadAsync(await readFile(sheet));
    const afterZip = await JSZip.loadAsync(await readFile(changed));
    assert.equal(
      await beforeZip.file('xl/styles.xml')?.async('string'),
      await afterZip.file('xl/styles.xml')?.async('string'),
    );
    assert.equal(
      await beforeZip.file('xl/workbook.xml')?.async('string'),
      await afterZip.file('xl/workbook.xml')?.async('string'),
    );
    assert.match(await readFile(path.join(root, 'sheet.html'), 'utf8'), /Revenue/);
  },
);

/**
 * Regression: editing an empty (self-closing) cell used to swallow the neighbouring cell.
 * The worksheet scanner matched `<c r="A1"/><c r="B1"><v>2</v></c>` as ONE element, so
 * replacing A1 deleted B1 — a silent data loss that the SHA-256 and reopen checks miss,
 * because the produced file is still structurally valid.
 */
test('an XLSX edit of a self-closing cell leaves the following cell intact', async (t) => {
  const root = await tempRoot(t, 'yuantu-excel-selfclosing-');
  const source = path.join(root, 'template.xlsx');
  const output = path.join(root, 'edited.xlsx');
  // A minimal workbook whose first row is exactly the shape that triggered the bug: an empty
  // self-closing cell immediately followed by a cell that holds a value.
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1"/><c r="B1"><v>2</v></c></row>' +
      '</sheetData></worksheet>',
  );
  await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));

  await runOfficeAutomation({
    operation: 'edit',
    format: 'xlsx',
    sourcePath: source,
    outputPath: output,
    cells: [{ sheet: 'Results', cell: 'A1', value: 5 }],
  });

  const sheet = await (
    await JSZip.loadAsync(await readFile(output))
  )
    .file('xl/worksheets/sheet1.xml')
    ?.async('string');
  const cells = [...(sheet ?? '').matchAll(/<c\b[^>]*?\br="([A-Z]+\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(cells, ['A1', 'B1'], `neighbouring cell was lost: ${sheet}`);
  assert.match(sheet ?? '', /<c r="A1"><v>5<\/v><\/c>/);
  assert.match(sheet ?? '', /<c r="B1"><v>2<\/v><\/c>/);
  // And the result still parses as a workbook with both values present.
  const book = XLSX.read(await readFile(output), { type: 'buffer' });
  assert.equal(book.Sheets.Results?.A1?.v, 5);
  assert.equal(book.Sheets.Results?.B1?.v, 2);
});

// ---- merged from office-tools.test.ts ----

test('XLSX inspection exposes full dimensions independently of the bounded sample', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-dimensions-');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(Array.from({ length: 71 }, (_, index) => [index, 'fixture', 1, 2])),
    'Fixture',
  );
  await writeFile(
    path.join(root, 'fixture.xlsx'),
    XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
  );
  const tool = officeTools(root).find((item) => item.name === 'office_inspect')!;
  const result = await tool.execute(
    { path: 'fixture.xlsx' },
    { signal: new AbortController().signal, approve: async () => false },
  );
  assert.equal(result.isError, false);
  const sheet = JSON.parse(result.content).sheets[0];
  assert.equal(sheet.range, 'A1:D71');
  assert.equal(sheet.rows, 71);
  assert.equal(sheet.columns, 4);
  assert.equal(sheet.sample.length, 30);
  assert.equal(sheet.sampleTruncated, true);
});

test('Office tools create, inspect, edit and preview XLSX behind write approval', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-tools-');
  const registry = new ToolRegistry();
  officeTools(root).forEach((tool) => registry.register(tool));
  const signal = new AbortController().signal;
  const created: string[] = [];
  const journal = {
    prepare(change: { path: string }) {
      created.push(change.path);
      return 'journal-id';
    },
    applied() {},
  };
  const run = (id: string, name: string, args: Record<string, unknown>, allow: boolean) =>
    registry.execute(
      { id, name, arguments: args },
      {
        signal,
        approve: async () => allow,
        fileJournal: journal,
      },
    );
  const create = {
    format: 'xlsx',
    path: 'report.xlsx',
    sheets: [
      {
        name: 'Summary',
        rows: [
          ['Metric', 'Value'],
          ['Revenue', 947],
        ],
      },
    ],
  };
  assert.equal((await run('deny', 'office_create', create, false)).isError, true);
  await assert.rejects(readFile(path.join(root, 'report.xlsx')));
  assert.equal((await run('create', 'office_create', create, true)).isError, false);
  assert.deepEqual(created, ['report.xlsx']);
  const inspected = await run('inspect', 'office_inspect', { path: 'report.xlsx' }, false);
  assert.equal(inspected.isError, false);
  assert.match(inspected.content, /Revenue/);
  const edited = await run(
    'edit',
    'office_edit',
    {
      source_path: 'report.xlsx',
      output_path: 'revised.xlsx',
      cells: [{ sheet: 'Summary', cell: 'B2', value: 948 }],
    },
    true,
  );
  assert.equal(edited.isError, false);
  const book = XLSX.read(await readFile(path.join(root, 'revised.xlsx')), { type: 'buffer' });
  assert.equal(book.Sheets.Summary?.B2?.v, 948);
  assert.equal(
    (
      await run(
        'preview',
        'office_preview',
        {
          source_path: 'revised.xlsx',
          output_path: 'preview.html',
        },
        true,
      )
    ).isError,
    false,
  );
  assert.match(await readFile(path.join(root, 'preview.html'), 'utf8'), /Revenue/);
});

// ---- merged from delivery-tool.test.ts ----

test('Agent verifies a delivered file without write approval and cannot escape workspace', async (t) => {
  const root = await tempRoot(t, 'yuantu-delivery-tool-');
  await writeFile(path.join(root, 'result.txt'), 'validated output');
  const registry = new ToolRegistry();
  registry.register(deliveryTool(root));
  const run = (file: string) =>
    registry.execute(
      {
        id: file,
        name: 'verify_file_delivery',
        arguments: { path: file, format: 'text' },
      },
      { signal: new AbortController().signal, approve: async () => false },
    );
  const good = await run('result.txt');
  assert.equal(good.isError, false);
  assert.match(good.content, /verified/);
  assert.match(good.content, /sha256/);
  const outside = await run('../outside.txt');
  assert.equal(outside.isError, true);
  const missing = await run('missing.txt');
  assert.equal(missing.isError, true);
});
/**
 * The legacy Office formats, verified rather than merely listed.
 *
 * The tool's schema offered `xls` while the verifier's rules had nothing for that extension, so the two
 * disagreed about what "supported format" meant: the schema advertised a structural check the code did not
 * perform, and `doc` / `ppt` — the formats templates usually arrive in — were accepted as `binary` with no
 * structure test at all. Both directions are pinned here: a real compound file passes, and a file whose
 * extension claims one but whose bytes are plain text fails.
 */
test('delivery verification covers the legacy Office formats, not just their extensions', async (t) => {
  const root = await tempRoot(t, 'yuantu-delivery-legacy-');
  const ole = Buffer.concat([
    Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]),
    Buffer.alloc(512, 7),
  ]);
  for (const extension of ['doc', 'xls', 'ppt']) {
    await writeFile(path.join(root, `template.${extension}`), ole);
    const evidence = await verifyFileDelivery(root, { path: `template.${extension}` });
    assert.equal(evidence.format, extension);
    assert.match(evidence.validation, /basic format structure verified/);
    await writeFile(path.join(root, `fake.${extension}`), 'plain text, compound signature missing');
    await assert.rejects(
      verifyFileDelivery(root, { path: `fake.${extension}` }),
      /compound-file signature/,
    );
  }
  // The vocabulary the model is offered is the verifier's own list, so neither can grow without the other.
  const schema = deliveryTool(root).inputSchema as {
    properties?: { format?: { enum?: unknown } };
  };
  assert.deepEqual(schema.properties?.format?.enum, [...deliveryFormats]);
});
/**
 * The schema and the engine promise the same workbook.
 *
 * `office_create` used to advertise more sheets than `runSpreadsheetOperation` would build, so a call in the
 * gap validated at the tool boundary and failed in the engine — the one shape of limit that is worse than a
 * smaller limit, because the tool description said the request was acceptable. One constant now feeds both,
 * and this pins the two readers to it.
 */
test('office_create advertises exactly the workbook the engine builds', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-sheets-');
  const tool = officeTools(root).find((item) => item.name === 'office_create')!;
  const schema = tool.inputSchema as { properties?: { sheets?: { maxItems?: number } } };
  const declared = schema.properties?.sheets?.maxItems;
  assert.equal(declared, MAX_CREATED_SHEETS);
  const sheet = (name: string) => ({ name, rows: [['value']] });
  const atLimit = Array.from({ length: MAX_CREATED_SHEETS }, (_, index) => sheet(`S${index}`));
  const create = (sheets: { name: string; rows: string[][] }[]) =>
    runOfficeOperation(tool, { format: 'xlsx', path: 'book.xlsx', sheets });
  await create(atLimit);
  assert.ok((await readFile(path.join(root, 'book.xlsx'))).length > 0);
  /**
   * One over the limit is refused, whichever reader gets there first.
   *
   * The schema rejects it during validation and the engine has its own message for a request that reached it
   * anyway, so the assertion accepts both: what the test is pinning is that the published bound really is the
   * enforced one, not the wording of whichever layer happened to answer.
   */
  await assert.rejects(
    create([...atLimit, sheet('extra')]),
    new RegExp(`(1 to ${MAX_CREATED_SHEETS}|more than ${MAX_CREATED_SHEETS} items)`),
  );
});
/**
 * Word and PowerPoint creation is pure JavaScript, so these run on every platform and never skip for a missing
 * Office: a failure here is a failure of the generator, not of the machine.
 */
test('office_create builds a Word document from blocks without Microsoft Office', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-create-');
  const tool = officeTools(root).find((item) => item.name === 'office_create')!;
  await runOfficeOperation(tool, {
    format: 'docx',
    path: 'report.docx',
    title: 'Quarterly Plan',
    paragraphs: ['Opening paragraph'],
    blocks: [
      { type: 'heading', text: 'Goals', level: 2 },
      { type: 'paragraph', text: 'First line\nSecond line' },
      { type: 'list', items: ['Bullet one', 'Bullet two'] },
      { type: 'list', items: ['Step one'], ordered: true },
      { type: 'page_break' },
      {
        type: 'table',
        rows: [['Metric', 'Value'], ['Revenue', '947'], ['Short row']],
      },
    ],
  });
  const bytes = await readFile(path.join(root, 'report.docx'));
  const mammoth = (await import('mammoth')).default;
  const text = (await mammoth.extractRawText({ buffer: bytes })).value;
  for (const expected of [
    'Quarterly Plan',
    'Opening paragraph',
    'Goals',
    'First line',
    'Second line',
    'Bullet two',
    'Step one',
    'Revenue',
    '947',
    'Short row',
  ])
    assert.match(text, new RegExp(expected));
  // Order is the order of the request: title, then paragraphs, then blocks.
  assert.ok(text.indexOf('Quarterly Plan') < text.indexOf('Opening paragraph'));
  assert.ok(text.indexOf('Opening paragraph') < text.indexOf('Goals'));
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
  assert.match(xml, /w:pStyle w:val="Title"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /<w:br w:type="page"\/>/);
  assert.equal(xml.match(/<w:tr\b/g)?.length, 3);
  // The short row is padded to the table's width instead of leaving a ragged grid.
  assert.equal(xml.match(/<w:tc>/g)?.length, 6);
});

test('office_create builds a PowerPoint deck with bullets, a table and notes without Microsoft Office', async (t) => {
  const root = await tempRoot(t, 'yuantu-pptx-create-');
  const tool = officeTools(root).find((item) => item.name === 'office_create')!;
  await runOfficeOperation(tool, {
    format: 'pptx',
    path: 'deck.pptx',
    title: 'Quarterly Review',
    slides: [
      { title: 'Quarterly Review' },
      { title: 'Highlights', body: ['Revenue up', 'Costs flat'], notes: 'Mention the hiring plan' },
      {
        title: 'Numbers',
        table: [
          ['Metric', 'Value'],
          ['Revenue', '947'],
        ],
      },
    ],
  });
  const bytes = await readFile(path.join(root, 'deck.pptx'));
  const slides = await readPptxSlides(bytes);
  assert.equal(slides.length, 3);
  assert.match(slides[0]!, /Quarterly Review/);
  assert.match(slides[1]!, /Revenue up/);
  assert.match(slides[1]!, /Costs flat/);
  assert.match(slides[2]!, /Metric/);
  assert.match(slides[2]!, /947/);
  const zip = await JSZip.loadAsync(bytes);
  const notes = Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/.+\.xml$/.test(name));
  const noteText = await Promise.all(notes.map((name) => zip.file(name)!.async('string')));
  assert.ok(noteText.some((xml) => xml.includes('Mention the hiring plan')));
  // Widescreen 13.333" × 7.5" in EMU.
  assert.match(
    await zip.file('ppt/presentation.xml')!.async('string'),
    /<p:sldSz cx="12192000" cy="6858000"/,
  );
});

test('the old Word and PowerPoint argument shapes still create through the JS generators', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-legacy-args-');
  const docx = path.join(root, 'legacy.docx');
  const pptx = path.join(root, 'legacy.pptx');
  await runOfficeAutomation({
    operation: 'create',
    format: 'docx',
    outputPath: docx,
    title: 'Plan',
    paragraphs: ['Keep original detail'],
  });
  await runOfficeAutomation({
    operation: 'create',
    format: 'pptx',
    outputPath: pptx,
    slides: [{ title: 'Plan', body: ['Keep this point'] }],
  });
  const mammoth = (await import('mammoth')).default;
  assert.match(
    (await mammoth.extractRawText({ buffer: await readFile(docx) })).value,
    /Keep original detail/,
  );
  assert.match((await readPptxSlides(await readFile(pptx))).join(' '), /Keep this point/);
});

test('office_create refuses tables and block lists past their published limits', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-create-limits-');
  const tool = officeTools(root).find((item) => item.name === 'office_create')!;
  const wide = [Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => 'x')];
  await assert.rejects(
    runOfficeOperation(tool, {
      format: 'docx',
      path: 'wide.docx',
      blocks: [{ type: 'table', rows: wide }],
    }),
  );
  await assert.rejects(
    runOfficeOperation(tool, {
      format: 'pptx',
      path: 'wide.pptx',
      slides: [{ title: 'Wide', table: wide }],
    }),
  );
  await assert.rejects(
    runOfficeOperation(tool, {
      format: 'docx',
      path: 'long.docx',
      blocks: Array.from({ length: MAX_DOCUMENT_BLOCKS + 1 }, () => ({ type: 'page_break' })),
    }),
  );
  await assert.rejects(
    runOfficeOperation(tool, {
      format: 'docx',
      path: 'unknown.docx',
      blocks: [{ type: 'image', path: 'logo.png' }],
    }),
  );
  await assert.rejects(readFile(path.join(root, 'wide.docx')));
  await assert.rejects(
    runOfficeOperation(tool, {
      format: 'pptx',
      path: 'tall.pptx',
      slides: [
        { title: 'Tall', table: Array.from({ length: MAX_SLIDE_TABLE_ROWS + 1 }, () => ['x']) },
      ],
    }),
  );
});

/** Characters XML 1.0 forbids in content; one of them in a part makes Word and PowerPoint call the file corrupt. */
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
async function xmlParts(file: string, pattern: RegExp): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(file));
  return Promise.all(
    Object.keys(zip.files)
      .filter((name) => !zip.files[name]!.dir && pattern.test(name))
      .map((name) => zip.file(name)!.async('string')),
  );
}

test('control characters in model text are dropped instead of corrupting the package', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-control-chars-');
  const docx = path.join(root, 'made.docx');
  const pptx = path.join(root, 'made.pptx');
  const edited = path.join(root, 'edited.docx');
  await runOfficeAutomation({
    operation: 'create',
    format: 'docx',
    outputPath: docx,
    title: 'Ti\u0001tle',
    paragraphs: ['Hel\u000blo NAME'],
    blocks: [
      { type: 'list', items: ['it\u0007em'] },
      { type: 'table', rows: [['ce\u001fll']] },
    ],
  });
  await runOfficeAutomation({
    operation: 'create',
    format: 'pptx',
    outputPath: pptx,
    title: 'De\u0002ck',
    slides: [
      { title: 'Sl\u0002ide', body: ['po\u0007int'], table: [['ce\u0008ll']], notes: 'no\u0003te' },
    ],
  });
  await runOfficeAutomation({
    operation: 'edit',
    format: 'docx',
    sourcePath: docx,
    outputPath: edited,
    replacements: [{ from: 'NAME', to: 'Ada\u0003 Lovelace' }],
  });
  for (const xml of [
    ...(await xmlParts(docx, /\.xml$/)),
    ...(await xmlParts(pptx, /\.xml$/)),
    ...(await xmlParts(edited, /\.xml$/)),
  ])
    assert.doesNotMatch(xml, XML_FORBIDDEN);
  const mammoth = (await import('mammoth')).default;
  const text = (await mammoth.extractRawText({ buffer: await readFile(edited) })).value;
  for (const expected of ['Title', 'Hello Ada Lovelace', 'item', 'cell'])
    assert.match(text, new RegExp(expected));
  const slides = (await readPptxSlides(await readFile(pptx))).join(' ');
  for (const expected of ['Slide', 'point', 'cell']) assert.match(slides, new RegExp(expected));
  assert.ok((await xmlParts(pptx, /^ppt\/notesSlides\//)).some((xml) => xml.includes('note')));
});

test('each ordered list in a Word document starts again at 1', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-ordered-');
  const docx = path.join(root, 'lists.docx');
  await runOfficeAutomation({
    operation: 'create',
    format: 'docx',
    outputPath: docx,
    blocks: [
      { type: 'list', ordered: true, items: ['a1', 'a2'] },
      { type: 'paragraph', text: 'between' },
      { type: 'list', ordered: true, items: ['b1', 'b2'] },
    ],
  });
  const [xml] = await xmlParts(docx, /^word\/document\.xml$/);
  const numId = (item: string) =>
    xml!.match(new RegExp(`<w:numId w:val="(\\d+)"/>(?:(?!</w:p>).)*?<w:t[^>]*>${item}<`))?.[1];
  assert.ok(numId('a1'));
  assert.equal(numId('a1'), numId('a2'), 'items of one list share a numbering instance');
  assert.notEqual(numId('a1'), numId('b1'), 'a second list gets its own instance, so it restarts');
  // The second instance must restart its counter rather than continue the first one's.
  const [numbering] = await xmlParts(docx, /^word\/numbering\.xml$/);
  const instance = numbering!.match(
    new RegExp(`<w:num w:numId="${numId('b1')}"[^>]*>(?:(?!</w:num>).)*</w:num>`),
  )?.[0];
  assert.match(instance ?? '', /<w:startOverride w:val="1"\/>/);
});

/** Shapes of a slide as EMU rectangles: `y` and height of every placed frame. */
function frames(xml: string): { y: number; cy: number }[] {
  return [...xml.matchAll(/<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/g)].map(
    (match) => ({ y: Number(match[1]), cy: Number(match[2]) }),
  );
}
const SLIDE_HEIGHT_EMU = 6858000;

test('a slide table at its row limit stays on the slide, under bullets too', async (t) => {
  const root = await tempRoot(t, 'yuantu-pptx-tall-table-');
  const pptx = path.join(root, 'tall.pptx');
  const table = Array.from({ length: MAX_SLIDE_TABLE_ROWS }, (_, row) => [`r${row}`, 'value']);
  await runOfficeAutomation({
    operation: 'create',
    format: 'pptx',
    outputPath: pptx,
    slides: [
      { title: 'Table only', table },
      { title: 'Bullets and table', body: ['One', 'Two', 'Three'], table },
    ],
  });
  const slides = await xmlParts(pptx, /^ppt\/slides\/slide\d+\.xml$/);
  assert.equal(slides.length, 2);
  for (const xml of slides) {
    // A row is drawn at least as tall as one line of its text plus the cell margins, whatever `h` says, so a
    // written height of 0 must not pass for a table that fits.
    const table = xml.slice(xml.indexOf('<a:tbl>'));
    const size = Number(table.match(/\bsz="(\d+)"/)![1]) / 100;
    const margins =
      Number(table.match(/marT="(\d+)"/)![1]) + Number(table.match(/marB="(\d+)"/)![1]);
    const lineEmu = Math.ceil(size * 1.2 * 12_700) + margins;
    const rowHeights = [...table.matchAll(/<a:tr h="(\d+)"/g)].map((match) =>
      Math.max(Number(match[1]), lineEmu),
    );
    assert.equal(rowHeights.length, MAX_SLIDE_TABLE_ROWS);
    const tableTop = frames(xml).at(-1)!.y;
    const bottom = tableTop + rowHeights.reduce((sum, height) => sum + height, 0);
    assert.ok(bottom <= SLIDE_HEIGHT_EMU, `table ends at ${bottom} EMU, past the slide`);
  }
});

test('long bullet lists get a smaller font instead of overflowing their box', async (t) => {
  const root = await tempRoot(t, 'yuantu-pptx-bullets-');
  const pptx = path.join(root, 'bullets.pptx');
  const long =
    'A bullet that runs on for quite a while to need more than one line of the slide width. '.repeat(
      2,
    );
  await runOfficeAutomation({
    operation: 'create',
    format: 'pptx',
    outputPath: pptx,
    slides: [
      { title: 'Short', body: ['One', 'Two'] },
      { title: 'Long', body: Array.from({ length: 14 }, () => long) },
      {
        title: 'Long with table',
        body: Array.from({ length: 6 }, () => long),
        table: [['a'], ['b']],
      },
    ],
  });
  const slides = await xmlParts(pptx, /^ppt\/slides\/slide\d+\.xml$/);
  const sizes = (xml: string) =>
    [...xml.matchAll(/<a:rPr[^>]*\bsz="(\d+)"[^>]*>(?:(?!<\/a:r>).)*?<a:t>(One|A bullet)/g)].map(
      (match) => Number(match[1]),
    );
  const byTitle = (title: string) => slides.find((xml) => xml.includes(`<a:t>${title}</a:t>`))!;
  assert.deepEqual(
    [...new Set(sizes(byTitle('Short')))],
    [2000],
    'short lists keep the 20 pt default',
  );
  for (const title of ['Long', 'Long with table']) {
    const found = sizes(byTitle(title));
    assert.ok(found.length > 0);
    assert.ok(Math.max(...found) < 2000, `${title}: ${found[0]} is not smaller than 20 pt`);
  }
});

/** One `office_create` call through the tool's own execute, with the approval it needs already granted. */
async function runOfficeOperation(
  tool: ReturnType<typeof officeTools>[number],
  args: Record<string, unknown>,
): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await registry.execute(
    { id: 'create', name: tool.name, arguments: args },
    {
      signal: new AbortController().signal,
      approve: async () => true,
      fileJournal: { prepare: () => 'journal-id', applied() {} },
    },
  );
  if (result.isError) throw new Error(result.content);
}

// ---- OOXML decompression bounds ----
/**
 * A package that is small on disk and enormous once opened.
 *
 * This is the shape the bound exists for: the compressed member is a few kilobytes of repeated text, so every
 * check that measures the *input* — the 20 MB package limit included — passes, and only a limit applied while the
 * part is inflated can refuse it. The bound this replaced ran on `.length` after `async('string')` had already
 * produced the whole string, so the cost of finding out had been paid by the process before the check happened.
 */
const PPTX_PRESENTATION = (slides: string): string =>
  `<p:presentation><p:sldIdLst>${slides}</p:sldIdLst></p:presentation>`;
const PPTX_SLIDE_ID = '<p:sldId id="256" r:id="rId1"/>';
const PPTX_RELS =
  '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>';

test('a presentation part that inflates past its bound is refused, in a package every input check accepts', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', 'a'.repeat(24_000_000));
  zip.file('ppt/_rels/presentation.xml.rels', PPTX_RELS);
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bomb.length < 20_000_000, 'the package itself passes the 20 MB input limit');
  // Before the bound existed this part had no limit at all: it was read into a 24 MB string and the failure the
  // caller saw came from the missing slides further down, not from the size.
  await assert.rejects(() => readPptxSlides(bomb), /PPTX presentation XML is too large/);
});

test('the relationship part is bounded, so a bomb there cannot pass as a presentation', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', PPTX_PRESENTATION(PPTX_SLIDE_ID));
  zip.file('ppt/_rels/presentation.xml.rels', 'a'.repeat(24_000_000));
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bomb.length < 20_000_000);
  await assert.rejects(() => readPptxSlides(bomb), /PPTX relationship XML is too large/);
});

test('a slide part that inflates past its bound is refused while it is being read', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', PPTX_PRESENTATION(PPTX_SLIDE_ID));
  zip.file('ppt/_rels/presentation.xml.rels', PPTX_RELS);
  zip.file('ppt/slides/slide1.xml', `<p:sld><a:t>${'a'.repeat(24_000_000)}</a:t></p:sld>`);
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bomb.length < 20_000_000);
  // The slide part had a post-decompression check before this change, so this test states the boundary rather
  // than proving a repair; it fails if a refactor drops the bound while keeping the streaming reader.
  await assert.rejects(() => readPptxSlides(bomb), /PPTX slide XML is too large/);
});

test('a small package of the same shape still reads part by part', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', PPTX_PRESENTATION(PPTX_SLIDE_ID));
  zip.file('ppt/_rels/presentation.xml.rels', PPTX_RELS);
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Hello from the bounded reader</a:t></p:sld>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  // The streaming reader has to return exactly what `async('string')` returned, or the bound has broken reading.
  assert.deepEqual(await readPptxSlides(bytes), ['Hello from the bounded reader']);
});

test('an oversized workbook part is refused before any worksheet is located', async (t) => {
  const root = await tempRoot(t, 'yuantu-ooxml-bound-');
  const zip = new JSZip();
  zip.file('xl/workbook.xml', 'a'.repeat(24_000_000));
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships/>');
  const source = path.join(root, 'book.xlsx');
  await writeFile(source, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.ok(
    (await readFile(source)).length < 20_000_000,
    'the package itself passes the input limit',
  );
  // `xl/workbook.xml` had no bound at all before this change, which is why this is the sharpest of the five.
  await assert.rejects(
    () =>
      runSpreadsheetOperation({
        operation: 'edit',
        format: 'xlsx',
        sourcePath: source,
        outputPath: path.join(root, 'out.xlsx'),
        cells: [{ sheet: 'Sheet1', cell: 'A1', value: 'x' }],
      }),
    /Excel workbook XML is too large/,
  );
});

/**
 * `office_inspect` is the one Office path that hands a package to a reader this repository does not own — mammoth
 * for DOCX, SheetJS for XLSX — and neither library bounds what it inflates on the way in. The 20 MB check above
 * them is about the *compressed* file, which is the number the package's author writes, so a small package with
 * one enormous part passed every input check and was handed over whole.
 *
 * Measured on the unfixed code with the fixtures below: a **24,312-byte** DOCX made mammoth return the whole
 * 24,000,002-character text, and a **25,087-byte** XLSX made SheetJS parse the part (heap +23 MB).
 */
const CONTENT_TYPES = (overrides: string): string =>
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  overrides +
  '</Types>';
const OFFICE_DOCUMENT_RELS = (target: string): string =>
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
  ` Target="${target}"/></Relationships>`;
/** The smallest DOCX mammoth accepts, so a failure here is about the bound and not about package shape. */
function docxWithDocumentXml(documentXml: string): JSZip {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    CONTENT_TYPES(
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ),
  );
  zip.file('_rels/.rels', OFFICE_DOCUMENT_RELS('word/document.xml'));
  zip.file('word/document.xml', documentXml);
  return zip;
}
/** The smallest XLSX SheetJS accepts, for the same reason. */
function xlsxWithSheetXml(sheetXml: string): JSZip {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    CONTENT_TYPES(
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    ),
  );
  zip.file('_rels/.rels', OFFICE_DOCUMENT_RELS('xl/workbook.xml'));
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"' +
      ' Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip;
}
const WORD_BODY = (text: string): string =>
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
  text +
  '</w:t></w:r></w:p></w:body></w:document>';

test('a DOCX whose document part inflates past its ceiling is refused before mammoth reads it', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-inspect-bound-');
  const bomb = await docxWithDocumentXml(WORD_BODY('a'.repeat(24_000_000))).generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  assert.ok(bomb.length < 20_000_000, 'the package itself passes the 20 MB input limit');
  await writeFile(path.join(root, 'bomb.docx'), bomb);
  const tool = officeTools(root).find((item) => item.name === 'office_inspect')!;
  await assert.rejects(
    () =>
      tool.execute(
        { path: 'bomb.docx' },
        { signal: new AbortController().signal, approve: async () => false },
      ),
    /DOCX package part word\/document\.xml is too large/,
  );
});

test('an XLSX whose worksheet part inflates past its ceiling is refused before SheetJS reads it', async (t) => {
  const root = await tempRoot(t, 'yuantu-xlsx-inspect-bound-');
  const bomb = await xlsxWithSheetXml(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
      `<c r="A1" t="inlineStr"><is><t>${'a'.repeat(24_000_000)}</t></is></c>` +
      '</row></sheetData></worksheet>',
  ).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bomb.length < 20_000_000, 'the package itself passes the 20 MB input limit');
  await writeFile(path.join(root, 'bomb.xlsx'), bomb);
  const tool = officeTools(root).find((item) => item.name === 'office_inspect')!;
  await assert.rejects(
    () =>
      tool.execute(
        { path: 'bomb.xlsx' },
        { signal: new AbortController().signal, approve: async () => false },
      ),
    /XLSX package part xl\/worksheets\/sheet1\.xml is too large/,
  );
});

test('a small DOCX of the same shape still inspects to its text', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-inspect-small-');
  const bytes = await docxWithDocumentXml(
    WORD_BODY('Hello from the bounded inspect path'),
  ).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(path.join(root, 'small.docx'), bytes);
  const tool = officeTools(root).find((item) => item.name === 'office_inspect')!;
  const result = await tool.execute(
    { path: 'small.docx' },
    { signal: new AbortController().signal, approve: async () => false },
  );
  // The bound must price the package without changing what a readable one returns.
  assert.equal(result.isError, false);
  assert.match(result.content, /Hello from the bounded inspect path/);
});

// ---- Word and PowerPoint template edits without Office ----
const SPLIT_RUNS =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r><w:r><w:t>wor</w:t></w:r>' +
  '<w:proofErr w:type="spellStart"/><w:r><w:t xml:space="preserve">ld again</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>wor</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>ld</w:t></w:r></w:p>' +
  '</w:body></w:document>';

test('a Word edit replaces text split across runs and keeps the first run formatting', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-edit-runs-');
  const source = path.join(root, 'source.docx');
  const output = path.join(root, 'edited.docx');
  await writeFile(
    source,
    await docxWithDocumentXml(SPLIT_RUNS).generateAsync({ type: 'nodebuffer' }),
  );
  await runOfficeAutomation({
    operation: 'edit',
    format: 'docx',
    sourcePath: source,
    outputPath: output,
    replacements: [{ from: 'world', to: 'planet & <co>' }],
  });
  const after = await JSZip.loadAsync(await readFile(output));
  const xml = await after.file('word/document.xml')!.async('string');
  // The match started in the plain "wor" run, so the replacement lands there; the bold run is untouched.
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t>Hello <\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve">planet &amp; &lt;co&gt;<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve"> again<\/w:t>/);
  // Paragraph boundaries are respected: "wor" + "ld" in separate paragraphs is not a match.
  assert.match(xml, /<w:p><w:r><w:t>wor<\/w:t><\/w:r><\/w:p><w:p\/><w:p><w:r><w:t>ld<\/w:t>/);
  const mammoth = (await import('mammoth')).default;
  const text = (await mammoth.extractRawText({ buffer: await readFile(output) })).value;
  assert.match(text, /Hello planet & <co> again/);
  // Parts the edit did not need are carried over unchanged.
  const before = await JSZip.loadAsync(await readFile(source));
  assert.equal(
    await before.file('[Content_Types].xml')!.async('string'),
    await after.file('[Content_Types].xml')!.async('string'),
  );
});

test('a Word edit that matches nothing fails and writes nothing', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-edit-missing-');
  const source = path.join(root, 'source.docx');
  await writeFile(
    source,
    await docxWithDocumentXml(WORD_BODY('present')).generateAsync({ type: 'nodebuffer' }),
  );
  await assert.rejects(
    runOfficeAutomation({
      operation: 'edit',
      format: 'docx',
      sourcePath: source,
      outputPath: path.join(root, 'edited.docx'),
      replacements: [
        { from: 'present', to: 'kept' },
        { from: 'absent', to: 'x' },
      ],
    }),
    /Word text not found: absent/,
  );
  await assert.rejects(readFile(path.join(root, 'edited.docx')));
});

test('Word edits replace long text and treat ^ literally', async (t) => {
  // Word's COM Find refused text over 255 characters and read ^ as a code; the JS path has neither limit.
  const root = await tempRoot(t, 'yuantu-office-long-');
  const source = path.join(root, 'source.docx');
  const output = path.join(root, 'edited.docx');
  const long = 'Long clause '.repeat(30).trim(); // 359 characters
  await runOfficeAutomation({
    operation: 'create',
    format: 'docx',
    outputPath: source,
    paragraphs: ['Keep this', long, 'Cost 3^2 units', long],
  });
  await runOfficeAutomation({
    operation: 'edit',
    format: 'docx',
    sourcePath: source,
    outputPath: output,
    replacements: [
      { from: long, to: 'Short clause' },
      { from: '3^2', to: '9^1 '.repeat(80).trim() },
    ],
  });
  const mammoth = (await import('mammoth')).default;
  const text = (await mammoth.extractRawText({ buffer: await readFile(output) })).value;
  assert.match(text, /Keep this/);
  assert.doesNotMatch(text, /Long clause/);
  assert.equal(text.match(/Short clause/g)?.length, 2);
  assert.match(text, /Cost (9\^1 ){79}9\^1 units/);
});

test('office_edit revises slide text and table cells of a PowerPoint deck without Office', async (t) => {
  const root = await tempRoot(t, 'yuantu-pptx-edit-');
  const tools = officeTools(root);
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  await runOfficeOperation(tool('office_create'), {
    format: 'pptx',
    path: 'deck.pptx',
    slides: [
      { title: 'Draft review', body: ['Draft point'] },
      { title: 'Numbers', table: [['Metric', 'Draft value']] },
    ],
  });
  await runOfficeOperation(tool('office_edit'), {
    source_path: 'deck.pptx',
    output_path: 'final.pptx',
    replacements: [{ from: 'Draft', to: 'Final' }],
  });
  const slides = await readPptxSlides(await readFile(path.join(root, 'final.pptx')));
  assert.match(slides[0]!, /Final review/);
  assert.match(slides[0]!, /Final point/);
  assert.match(slides[1]!, /Final value/);
  assert.doesNotMatch(slides.join(' '), /Draft/);
  // The template is never modified.
  assert.match(
    (await readPptxSlides(await readFile(path.join(root, 'deck.pptx')))).join(' '),
    /Draft/,
  );
});

// ---- Built-in previews and engine fallback ----
test('an .html preview of Word and PowerPoint needs nothing installed and runs no script', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-html-preview-');
  let rendered = false;
  const tools = officeTools(root, {
    async render() {
      rendered = true;
    },
  });
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  await runOfficeOperation(tool('office_create'), {
    format: 'docx',
    path: 'report.docx',
    title: 'Report <script>alert(1)</script>',
    blocks: [
      {
        type: 'table',
        rows: [
          ['Metric', 'Value'],
          ['Revenue', '947'],
        ],
      },
    ],
  });
  await runOfficeOperation(tool('office_create'), {
    format: 'pptx',
    path: 'deck.pptx',
    slides: [{ title: 'Highlights', body: ['Revenue up'] }],
  });
  await runOfficeOperation(tool('office_preview'), {
    source_path: 'report.docx',
    output_path: 'report.html',
  });
  await runOfficeOperation(tool('office_preview'), {
    source_path: 'deck.pptx',
    output_path: 'deck.html',
  });
  const report = await readFile(path.join(root, 'report.html'), 'utf8');
  assert.match(report, /default-src 'none'/);
  assert.match(report, /<table>/);
  assert.match(report, /Revenue/);
  assert.doesNotMatch(report, /<script>/);
  const deck = await readFile(path.join(root, 'deck.html'), 'utf8');
  assert.match(deck, /Slide 1/);
  assert.match(deck, /Revenue up/);
  assert.equal(rendered, false);
});

// The `.pdf` fallback test drives real Word on Windows, so it lives in `office-native.test.ts`, which runs in the
// serial phase: two processes sharing the machine's one Office COM server close each other's documents.
test('a .pdf preview with no engine available says how to get a preview', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Office may be installed here; the no-engine path is pinned on other platforms');
    return;
  }
  const root = await tempRoot(t, 'yuantu-office-no-engine-');
  const tools = officeTools(root, {
    async render() {
      throw new OfficeUnavailableError('LibreOffice is unavailable');
    },
  });
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  await runOfficeOperation(tool('office_create'), {
    format: 'docx',
    path: 'report.docx',
    paragraphs: ['Body'],
  });
  await assert.rejects(
    runOfficeOperation(tool('office_preview'), {
      source_path: 'report.docx',
      output_path: 'report.pdf',
    }),
    /No PDF engine is available.*\.html output_path/s,
  );
});

test('an office_create approval shows the words the document will hold', async (t) => {
  const root = await tempRoot(t, 'office-outline-');
  const tool = officeTools(root).find((item) => item.name === 'office_create')!;
  const prepared = await tool.prepare!(
    {
      format: 'docx',
      path: '收入报告.docx',
      title: '收入报告',
      paragraphs: ['已支付收入 2,700'],
      blocks: [
        { type: 'heading', text: '明细', level: 2 },
        { type: 'list', items: ['甲公司 1,800', '乙公司 900'] },
        {
          type: 'table',
          rows: [
            ['客户', '金额'],
            ['甲公司', '1800'],
          ],
        },
      ],
    },
    {} as never,
  );
  const change = prepared!.change!;
  assert.equal(change.path, '收入报告.docx');
  assert.deepEqual(change.patch.split('\n'), [
    '+# 收入报告',
    '+已支付收入 2,700',
    '+## 明细',
    '+- 甲公司 1,800',
    '+- 乙公司 900',
    '+客户 | 金额',
    '+甲公司 | 1800',
  ]);
  assert.equal(change.added, 7);
  assert.equal(change.truncated, false);
});
