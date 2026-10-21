/**
 * Shared bits for the built-in Office preview pages.
 *
 * The preview is drawn inside the window, so the window's Content-Security-Policy applies to it too. The parent
 * keeps `style-src 'self' data:`: each page carries one external `data:` stylesheet instead of an inline
 * `<style>` block, which is why the page renders with its margins and cell borders under that policy. No script
 * and no network are added by this module.
 */
export type PreviewLanguage = 'zh' | 'en';

export function previewText(language: PreviewLanguage, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}

export function previewStyleLink(css: string): string {
  return `<link rel="stylesheet" href="data:text/css;charset=utf-8,${encodeURIComponent(css)}">`;
}
