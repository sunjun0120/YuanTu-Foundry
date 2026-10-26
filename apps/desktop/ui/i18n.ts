/**
 * The interface language as a React subscription.
 *
 * `onLocaleChange`/`locale` in `apps/desktop/i18n.ts` already own the language and the DOM walker's copy. This hook
 * adds the one thing React needs: a subscription whose snapshot is the language itself. It deliberately does not
 * cache a translated string — a component calls `t()` during render, so a language change re-renders it through the
 * store and the walker never has to rewrite text React owns.
 */
import { useSyncExternalStore } from 'react';
import { locale, onLocaleChange } from '../i18n.ts';
import type { UiLanguage } from '../ui-settings.ts';

export function useLocale(): UiLanguage {
  return useSyncExternalStore(onLocaleChange, locale);
}
