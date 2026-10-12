/**
 * esbuild's Node CommonJS bundles use the output file's URL. Resource lookups
 * must account for the bundle layout instead of assuming a source-module sibling.
 * Resolve lazily so Electron's sandboxed preload does not load Node builtins.
 */
export const commonJsModuleUrl = {
  define: { 'import.meta.url': '__yuantuBundleMeta.url' },
  banner: {
    js: "const __yuantuBundleMeta = { get url() { return require('node:url').pathToFileURL(__filename).href; } };",
  },
};
