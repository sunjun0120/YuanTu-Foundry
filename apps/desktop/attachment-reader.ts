import { readPptxSlides } from '../../packages/office/read.ts';
import path from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TEXT,
  type DocumentAttachment,
} from './attachment-contract.ts';
import { mainText } from './i18n.ts';
const textExtensions = new Set(
  'txt md markdown csv tsv json jsonl xml yaml yml toml ini cfg conf log js jsx ts tsx mjs cjs css scss less html htm vue svelte py java c h cpp hpp cs go rs rb php sh bash zsh ps1 bat cmd sql r swift kt dart env gitignore dockerfile'.split(
    ' ',
  ),
);
export async function extractAttachment(name: string, bytes: Buffer): Promise<DocumentAttachment> {
  if (!name || name.length > 256 || /[\x00-\x1f/\\]/.test(name))
    throw new Error('Invalid file name');
  if (!bytes.length) throw new Error(mainText('attach.emptyFile'));
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(mainText('attach.tooLarge'));
  const ext = path.extname(name).slice(1).toLowerCase();
  let text: string;
  if (ext === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200) throw new Error(mainText('attach.pdfTooManyPages'));
      const pages: string[] = [];
      let length = 0;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const value = content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('');
        length += value.length;
        if (length > MAX_DOCUMENT_TEXT) throw new Error(mainText('attach.textTooLong'));
        pages.push('第 ' + n + ' 页\n' + value);
        page.cleanup();
      }
      if (!pages.some((value) => value.replace(/^第 \d+ 页\n/, '').trim()))
        throw new Error(mainText('attach.pdfNoText'));
      text = pages.join('\n\n');
    } finally {
      await task.destroy();
    }
  } else if (ext === 'docx') {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else if (ext === 'pptx') {
    const slides = await readPptxSlides(bytes);
    text = slides.map((slide, index) => 'Slide ' + (index + 1) + '\n' + slide).join('\n\n');
  } else if (ext === 'xlsx' || ext === 'xls') {
    const book = XLSX.read(bytes, {
      type: 'buffer',
      sheetRows: 1001,
      cellFormula: false,
      cellHTML: false,
    });
    if (book.SheetNames.length > 50) throw new Error(mainText('attach.excelTooManySheets'));
    text = book.SheetNames.map((name) => {
      const sheet = book.Sheets[name]!;
      const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
      if (range.e.r >= 1000 || range.e.c >= 100) throw new Error(mainText('attach.excelTooLarge'));
      return '工作表：' + name + '\n' + XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    }).join('\n\n');
  } else if (textExtensions.has(ext) || textExtensions.has(name.toLowerCase().replace(/^\./, ''))) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff)
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      }
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error(mainText('attach.binary'));
  } else throw new Error(mainText('attach.unsupported'));
  if (!text.trim()) throw new Error(mainText('attach.emptyContent'));
  if (text.length > MAX_DOCUMENT_TEXT) throw new Error(mainText('attach.textTooLong'));
  return { name, text, size: bytes.length };
}
