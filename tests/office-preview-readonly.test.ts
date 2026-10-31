import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { readPptxSlides } from '../packages/office/read.ts';
import { officePreviewHtml } from '../packages/office/render.ts';
import { spreadsheetPreviewHtml } from '../packages/office/spreadsheet.ts';
import { writeDocx, writePptx, writeXlsx } from './office-fixtures.ts';
import { tempRoot } from './temp-fixture.ts';

test('a Word and PowerPoint preview needs nothing installed and runs no script', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-html-preview-');
  await writeDocx(path.join(root, 'report.docx'), {
    title: 'Report <script>alert(1)</script>',
    table: [
      ['Metric', 'Value'],
      ['Revenue', '947'],
    ],
  });
  await writePptx(path.join(root, 'deck.pptx'), ['Revenue up']);
  const report = await officePreviewHtml('docx', path.join(root, 'report.docx'));
  assert.match(report, /default-src 'none'/);
  assert.match(report, /Word 预览/);
  assert.match(report, /data:text\/css/);
  assert.match(report, /<table>/);
  assert.match(report, /Revenue/);
  assert.doesNotMatch(report, /<script>/);
  const deck = await officePreviewHtml('pptx', path.join(root, 'deck.pptx'));
  assert.match(deck, /PowerPoint 预览/);
  assert.match(deck, /第 1 页/);
  assert.match(deck, /Revenue up/);
  const english = await officePreviewHtml('docx', path.join(root, 'report.docx'), 'en');
  assert.match(english, /Word preview/);
  assert.match(english, /Built-in preview/);
});

test('a workbook preview shows formula cells as formulas, styled without an inline style block', async (t) => {
  const root = await tempRoot(t, 'yuantu-excel-formula-');
  const file = path.join(root, 'totals.xlsx');
  await writeXlsx(
    file,
    [
      ['customer', 'orders', 'revenue'],
      ['A', 2, 1800],
      ['B', 1, 900],
      ['total', '=SUM(B2:B3)', '=SUM(C2:C3)'],
    ],
    'Summary',
  );
  // The in-app preview used to drop a formula-only cell and render the totals row blank. It also carried an
  // inline <style> block that the window's `style-src 'self'` policy refused, so the page had no borders.
  const html = await spreadsheetPreviewHtml(file, 'zh');
  assert.match(html, /Excel 数据预览/);
  assert.match(html, /=SUM\(B2:B3\)/);
  assert.match(html, /class="formula"/);
  assert.match(html, /<link rel="stylesheet" href="data:text\/css/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(await spreadsheetPreviewHtml(file, 'en'), /Excel data preview/);
  assert.match(await officePreviewHtml('xlsx', file, 'en'), /<td>customer<\/td>/);
});

test('slide text is read in slide order', async (t) => {
  const file = path.join(await tempRoot(t, 'yuantu-pptx-read-'), 'deck.pptx');
  await writePptx(file, ['First slide', 'Second slide']);
  const slides = await readPptxSlides(await readFile(file));
  assert.equal(slides.length, 2);
  assert.match(slides[0]!, /First slide/);
  assert.match(slides[1]!, /Second slide/);
});

// ---- OOXML decompression bounds ----
/**
 * A package that is small on disk and enormous once opened.
 *
 * This is the shape the bound exists for: the compressed member is a few kilobytes of repeated text, so every
 * check that measures the *input* — the 20 MB package limit included — passes, and only a limit applied while the
 * part is inflated can refuse it.
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

/** The smallest DOCX mammoth accepts, so a failure here is about the bound and not about package shape. */
function docxWithDocumentXml(documentXml: string): JSZip {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
      ' Target="word/document.xml"/></Relationships>',
  );
  zip.file('word/document.xml', documentXml);
  return zip;
}
const WORD_BODY = (text: string): string =>
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
  text +
  '</w:t></w:r></w:p></w:body></w:document>';

test('a DOCX whose document part inflates past its ceiling is refused before mammoth reads it', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-preview-bound-');
  const bomb = await docxWithDocumentXml(WORD_BODY('a'.repeat(24_000_000))).generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  assert.ok(bomb.length < 20_000_000, 'the package itself passes the 20 MB input limit');
  await writeFile(path.join(root, 'bomb.docx'), bomb);
  await assert.rejects(
    () => officePreviewHtml('docx', path.join(root, 'bomb.docx')),
    /DOCX package part word\/document\.xml is too large/,
  );
});

test('a small DOCX of the same shape still previews to its text', async (t) => {
  const root = await tempRoot(t, 'yuantu-docx-preview-small-');
  const bytes = await docxWithDocumentXml(
    WORD_BODY('Hello from the bounded preview path'),
  ).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(path.join(root, 'small.docx'), bytes);
  // The bound must price the package without changing what a readable one returns.
  assert.match(
    await officePreviewHtml('docx', path.join(root, 'small.docx')),
    /Hello from the bounded preview path/,
  );
});
