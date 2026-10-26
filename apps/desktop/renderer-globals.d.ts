/**
 * The desktop bridge the preload script exposes on the window.
 *
 * It lives in its own declaration file for one build reason: `tsconfig.build.json` excludes `renderer.ts` so the
 * compiler does not emit the React entry, but the renderer's plain modules still call `window.yuantu`. A global
 * declared inside an excluded module is invisible to the rest of the program, so the declaration has to be a
 * `.d.ts` the build keeps — excluding this file would break every `setup*` module with `Property 'yuantu' does not
 * exist on type 'Window'`.
 *
 * `renderer.ts` still declares the same property today; TypeScript merges the two while the entry is rewritten
 * (T6/T24), and the duplicate there goes away with the rest of its DOM orchestration.
 */
import type { DesktopBridge } from './contract.ts';

declare global {
  interface Window {
    yuantu: DesktopBridge;
  }
}

/**
 * Stylesheet imports are esbuild's, not TypeScript's.
 *
 * `renderer.ts` imports `@mantine/core/styles.css` so esbuild emits `renderer.css` beside the bundle; TypeScript has
 * no runtime for that import and would otherwise reject the specifier.
 */
declare module '*.css';
