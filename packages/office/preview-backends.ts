import type { OfficeFormat } from './automation.ts';

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
