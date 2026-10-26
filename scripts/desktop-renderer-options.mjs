/**
 * The one esbuild configuration for the renderer bundle.
 *
 * Kept apart from `build-desktop.mjs` so the toolchain test can run the *same* options over a temporary TSX
 * fixture — the alternative is a test that re-declares them and a build that quietly drifts away from the test.
 *
 * Two settings are the point of the React migration rather than incidental:
 *
 * - `jsx: 'automatic'` compiles components without a `React` import; the runtime comes from `react/jsx-runtime`.
 * - `define` pins React's `process.env.NODE_ENV` to `production`, so the development-only branches of React and
 *   Mantine drop out of the shipped bundle. A debug fixture that wants development warnings must override it.
 *
 * The CSS import in `renderer.ts` is what makes esbuild emit `dist/desktop/renderer.css` beside the script.
 */
export const RENDERER_ENTRY = 'apps/desktop/renderer.ts';
export const RENDERER_OUTFILE = 'dist/desktop/renderer.js';

/** @param {import('esbuild').BuildOptions} [overrides] */
export function rendererBuildOptions(overrides = {}) {
  return {
    entryPoints: [RENDERER_ENTRY],
    outfile: RENDERER_OUTFILE,
    bundle: true,
    platform: 'browser',
    target: 'chrome140',
    sourcemap: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    ...overrides,
  };
}
