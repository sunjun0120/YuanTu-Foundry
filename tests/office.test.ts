import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { readPptxSlides } from '../packages/office/read.ts';
import {
  isOfficeUnavailable,
  isScriptAuthorizationFailure,
  runOfficeAutomation,
} from '../packages/office/automation.ts';
import { verifyFileDelivery, deliveryFormats } from '../packages/core/delivery.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { officeTools } from '../packages/office/tools.ts';
import { MAX_CREATED_SHEETS, runSpreadsheetOperation } from '../packages/office/spreadsheet.ts';
import { deliveryTool } from '../packages/tools/delivery.ts';

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
 * Office. Only Word and PowerPoint need local Office, and a machine without it
 * skips with a reason instead of failing.
 */
test(
  'Excel creation, template edit and HTML preview preserve unaffected workbook parts',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-excel-workflow-'));
    t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-excel-selfclosing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-office-dimensions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-office-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-delivery-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-delivery-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-office-sheets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-ooxml-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-docx-inspect-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-xlsx-inspect-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-docx-inspect-small-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
