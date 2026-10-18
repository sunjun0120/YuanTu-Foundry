import { readFile, writeFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { OfficeUnavailableError, runOfficeAutomation, type OfficeFormat } from './automation.ts';
import type { OfficePreview } from './preview.ts';
import { readPptxSlides } from './read.ts';
import { runSpreadsheetOperation } from './spreadsheet.ts';
import { assertExpansionWithinBudget } from './zip-entry.ts';
import JSZip from 'jszip';

/**
 * Which engine renders a preview.
 *
 * `auto` picks by the output extension: `.html` is the built-in preview, which needs nothing installed; `.pdf`
 * tries local Microsoft Office for Word and PowerPoint, then LibreOffice. `native` keeps its original meaning —
 * Office PDF for Word and PowerPoint, the data HTML for Excel — so existing calls behave as they did.
 */
export const PREVIEW_BACKENDS = ['auto', 'html', 'office', 'libreoffice', 'native'] as const;
export type PreviewBackend = (typeof PREVIEW_BACKENDS)[number];
export type PreviewType = 'data-html' | 'document-html' | 'office-pdf' | 'libreoffice-pdf';

/** The output extensions a backend can produce for a format; the first is what `auto` would pick by default. */
export function previewExtensions(format: OfficeFormat, backend: PreviewBackend): string[] {
  switch (backend) {
    case 'auto':
      return ['.html', '.pdf'];
    case 'html':
      return ['.html'];
    case 'libreoffice':
      return ['.pdf'];
    case 'office':
      if (format === 'xlsx')
        throw new Error('The office preview backend renders Word and PowerPoint');
      return ['.pdf'];
    case 'native':
      return [format === 'xlsx' ? '.html' : '.pdf'];
  }
}

const HTML_BYTES = 16_000_000;
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
/**
 * The page around a built-in preview.
 *
 * The content comes from a document the user may have received from anyone, so the page forbids every script,
 * frame and network fetch: images can only be the `data:` URIs mammoth inlines, and links are inert text.
 */
function page(title: string, note: string, body: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    `<title>${escape(title)}</title>` +
    '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#222}' +
    'table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #bbb;padding:4px 8px}img{max-width:100%}' +
    'section{border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin:16px 0}.note{color:#666;font-size:13px}</style>' +
    `</head><body><p class="note">${escape(note)}</p>${body}</body></html>`
  );
}

async function documentHtml(sourcePath: string): Promise<string> {
  const bytes = await readFile(sourcePath);
  await assertExpansionWithinBudget(
    await JSZip.loadAsync(bytes),
    { part: 16_000_000, total: 48_000_000 },
    'DOCX package',
  );
  const { value } = await mammoth.convertToHtml({ buffer: bytes });
  // Links keep their text and lose their target: a preview is for reading, and a target is the one part of
  // the markup that can take the reader somewhere the document chose.
  const inert = value.replace(/<a\b[^>]*>/gi, '<span>').replace(/<\/a>/gi, '</span>');
  return page(
    'Word preview',
    'Built-in preview: text, headings, lists, tables and images; page layout and fonts are approximate.',
    inert,
  );
}

async function presentationHtml(sourcePath: string): Promise<string> {
  const slides = await readPptxSlides(await readFile(sourcePath));
  return page(
    'PowerPoint preview',
    'Built-in preview: slide text in order; layout, images and styling are not reproduced.',
    slides
      .map(
        (text, index) =>
          `<section><h2>Slide ${index + 1}</h2><p>${escape(text) || '<em>(no text)</em>'}</p></section>`,
      )
      .join(''),
  );
}

async function renderHtml(
  format: OfficeFormat,
  sourcePath: string,
  outputPath: string,
): Promise<PreviewType> {
  if (format === 'xlsx') {
    await runSpreadsheetOperation({ operation: 'preview', format, sourcePath, outputPath });
    return 'data-html';
  }
  const html =
    format === 'docx' ? await documentHtml(sourcePath) : await presentationHtml(sourcePath);
  if (Buffer.byteLength(html) > HTML_BYTES) throw new Error('Office preview HTML exceeds 16 MB');
  await writeFile(outputPath, html, 'utf8');
  return 'document-html';
}

/**
 * Render one preview with the requested engine, falling back where the request allows it.
 *
 * Only `auto` falls back, and only past an engine that is missing from this machine — Office not installed or
 * its script refused, LibreOffice not found. A conversion that ran and failed is reported as it is, because
 * retrying it in another engine would hide a broken document behind a different-looking PDF.
 */
export async function renderPreview(
  input: { format: OfficeFormat; sourcePath: string; outputPath: string; backend: PreviewBackend },
  renderer: OfficePreview,
  signal: AbortSignal,
): Promise<PreviewType> {
  const { format, sourcePath, outputPath, backend } = input;
  const pdf = outputPath.toLowerCase().endsWith('.pdf');
  const office = async (): Promise<PreviewType> => {
    await runOfficeAutomation({ operation: 'preview', format, sourcePath, outputPath }, signal);
    return 'office-pdf';
  };
  const libreoffice = async (): Promise<PreviewType> => {
    await renderer.render({ format, sourcePath, outputPath }, signal);
    return 'libreoffice-pdf';
  };
  if (backend === 'html' || (backend === 'auto' && !pdf))
    return renderHtml(format, sourcePath, outputPath);
  if (backend === 'native')
    return format === 'xlsx' ? renderHtml(format, sourcePath, outputPath) : office();
  if (backend === 'office') return office();
  if (backend === 'libreoffice' || format === 'xlsx') return libreoffice();
  try {
    return await office();
  } catch (officeError) {
    if (!(officeError instanceof OfficeUnavailableError)) throw officeError;
    try {
      return await libreoffice();
    } catch (libreError) {
      if (!(libreError instanceof OfficeUnavailableError)) throw libreError;
      throw new OfficeUnavailableError(
        'No PDF engine is available on this machine. Choose an .html output_path for the built-in preview, ' +
          'or install Microsoft Office or LibreOffice for a PDF. Office: ' +
          officeError.message.slice(0, 300) +
          ' LibreOffice: ' +
          libreError.message,
      );
    }
  }
}
