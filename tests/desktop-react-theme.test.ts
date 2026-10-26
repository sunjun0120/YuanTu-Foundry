import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appearanceFromDocument,
  createDesktopTheme,
  fontSizeFromDocument,
  resolveColorScheme,
  resolveFontSize,
} from '../apps/desktop/ui/theme.ts';

/**
 * The two pure mappings are the whole risk in the theme: a wrong system fallback makes an explicit light choice go
 * dark when the OS does, and a wrong size table silently shrinks every Mantine control. They are tested here rather
 * than through a browser because they are decisions, not rendering.
 */
test('an explicit appearance never follows the system, and system resolves through it', () => {
  assert.equal(resolveColorScheme('light', true), 'light');
  assert.equal(resolveColorScheme('dark', false), 'dark');
  assert.equal(resolveColorScheme('system', true), 'dark');
  assert.equal(resolveColorScheme('system', false), 'light');
});

test('the interface scale is 13/14/16 and an unknown value falls back to medium', () => {
  assert.equal(resolveFontSize('small'), 13);
  assert.equal(resolveFontSize('medium'), 14);
  assert.equal(resolveFontSize('large'), 16);
  assert.equal(resolveFontSize(undefined), 14);
  assert.equal(resolveFontSize('huge'), 14);
});

test('the document attributes are read defensively', () => {
  const doc = (theme?: string, size?: string) =>
    ({ documentElement: { dataset: { theme, fontSize: size } } }) as unknown as Document;
  assert.equal(appearanceFromDocument(doc('dark')), 'dark');
  assert.equal(appearanceFromDocument(doc('light')), 'light');
  assert.equal(appearanceFromDocument(doc()), 'system');
  assert.equal(appearanceFromDocument(doc('unexpected')), 'system');
  assert.equal(fontSizeFromDocument(doc(undefined, 'large')), 'large');
  assert.equal(fontSizeFromDocument(doc(undefined, 'small')), 'small');
  assert.equal(fontSizeFromDocument(doc()), 'medium');
});

test('the theme scales its size table from the chosen base', () => {
  assert.equal(createDesktopTheme(14).fontSizes?.md, '14px');
  assert.equal(createDesktopTheme(14).fontSizes?.sm, '13px');
  assert.equal(createDesktopTheme(16).fontSizes?.md, '16px');
  assert.equal(createDesktopTheme(16).fontSizes?.lg, '18px');
  assert.equal(createDesktopTheme(13).fontSizes?.xs, '11px');
});
