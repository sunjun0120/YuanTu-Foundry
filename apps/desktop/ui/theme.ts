/**
 * The project's fixed interface theme, palette and appearance/conversation-size mappings.
 *
 * The window already has one source of truth for appearance and text size: the general-settings controller writes
 * `data-theme` (`system|light|dark`) and `data-font-size` (`small|medium|large`) on the document element, and the
 * stylesheet reads those attributes. Conversation size affects message text through CSS, while Mantine's
 * interface size stays fixed. Mantine must not add a second appearance store — no `localStorage` colour scheme,
 * no provider-owned settings copy — so the provider subscribes to the appearance attribute and forces Mantine's
 * scheme from it. `system` resolves through `prefers-color-scheme`, while an explicit light/dark choice must not
 * move when the system changes.
 *
 * Colours are mapped onto the existing `--surface/--raised/--hover/--line/--ink/--muted/--accent` variables rather
 * than copied: a theme that repeats a hex value would let the two drift the first time the palette changed. Those
 * variables already switch per `data-theme`, so the mapping lives in Mantine's shared variables and not in a
 * per-scheme block.
 */
import {
  defaultCssVariablesResolver,
  type CSSVariablesResolver,
  type MantineThemeOverride,
} from '@mantine/core';

export type Appearance = 'system' | 'light' | 'dark';
export type FontSizeName = 'small' | 'medium' | 'large';

/** Conversation text choices; interface controls keep the standard 14px base. */
const BASE_FONT_SIZE: Record<FontSizeName, number> = { small: 13, medium: 14, large: 16 };

export function resolveColorScheme(appearance: Appearance, systemDark: boolean): 'light' | 'dark' {
  if (appearance === 'light' || appearance === 'dark') return appearance;
  return systemDark ? 'dark' : 'light';
}

export function resolveFontSize(name: string | undefined): number {
  return BASE_FONT_SIZE[name as FontSizeName] ?? BASE_FONT_SIZE.medium;
}

export function appearanceFromDocument(doc: Document): Appearance {
  const value = doc.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function fontSizeFromDocument(doc: Document): FontSizeName {
  const value = doc.documentElement.dataset.fontSize;
  return value === 'small' || value === 'large' ? value : 'medium';
}

/** The theme for one base size: a component's `sm`/`md` scale is derived from it, not fixed. */
export function createDesktopTheme(base: number): MantineThemeOverride {
  return {
    fontFamily:
      "var(--font-ui, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif)",
    fontSizes: {
      xs: `${base - 2}px`,
      sm: `${base - 1}px`,
      md: `${base}px`,
      lg: `${base + 2}px`,
      xl: `${base + 6}px`,
    },
    defaultRadius: 'md',
    headings: { fontWeight: '600' },
  };
}

/**
 * The palette bridge: Mantine's variables point at the project's own, so both themes stay one definition.
 *
 * The defaults are kept and only these entries are replaced; a resolver that returned only overrides would drop
 * every colour Mantine assumes (and the components would render transparent). `--mantine-color-body` and its
 * siblings are what the legacy sheets already call `--surface`, `--ink`, `--muted`, `--line`, `--raised`.
 */
export const desktopCssVariablesResolver: CSSVariablesResolver = (theme) => {
  const defaults = defaultCssVariablesResolver(theme);
  // The palette goes into every block the resolver emits, not only the shared one: Mantine's per-scheme blocks
  // redefine `--mantine-color-body` (and its siblings), so a shared-only override is overridden by the scheme the
  // provider just forced. Each value points at a project variable that itself switches on `data-theme`.
  const palette = {
    '--mantine-color-body': 'var(--surface)',
    '--mantine-color-text': 'var(--ink)',
    '--mantine-color-dimmed': 'var(--muted)',
    '--mantine-color-default': 'var(--raised)',
    '--mantine-color-default-hover': 'var(--hover)',
    '--mantine-color-default-border': 'var(--line)',
    '--mantine-color-anchor': 'var(--accent)',
    '--mantine-primary-color-filled': 'var(--accent)',
    '--mantine-primary-color-filled-hover': 'var(--accent-hover)',
  };
  return {
    variables: { ...defaults.variables, ...palette },
    light: { ...defaults.light, ...palette },
    dark: { ...defaults.dark, ...palette },
  };
};
