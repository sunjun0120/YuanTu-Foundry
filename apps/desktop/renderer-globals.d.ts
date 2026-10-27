/**
 * The desktop bridge the preload script exposes on the window.
 *
 * It lives in its own declaration file for one build reason: `tsconfig.build.json` excludes `renderer.ts` so the
 * compiler does not emit the React entry, but the renderer's plain modules still call `window.yuantu`. A global
 * declared inside an excluded module is invisible to the rest of the program, so the declaration has to be a
 * `.d.ts` the build keeps — excluding this file would break every `setup*` module with `Property 'yuantu' does not
 * exist on type 'Window'`.
 *
 * The entry now creates only the runtime and React root; the shared declaration stays here for DOM-island helpers.
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
