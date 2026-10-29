import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
import { SCHEMA_VERSION } from '../packages/storage/sqlite.ts';
import { commonJsModuleUrl } from './commonjs-module-url.mjs';
import { rendererBuildOptions } from './desktop-renderer-options.mjs';

await mkdir('dist/desktop', { recursive: true });
await build({
  entryPoints: [
    'apps/desktop/main.ts',
    'apps/desktop/attachment-worker.ts',
    'apps/desktop/preload.ts',
    'apps/desktop/sandbox-probe-worker.ts',
    'apps/desktop/project-search-worker.ts',
  ],
  outdir: 'dist/desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  ...commonJsModuleUrl,
  external: ['electron', 'pdfjs-dist/*', '@napi-rs/keyring'],
  sourcemap: true,
});
await build(rendererBuildOptions());
await copyFile('packages/office/automation.ps1', 'dist/desktop/automation.ps1');
await mkdir('dist/packages/office', { recursive: true });
await copyFile('packages/office/automation.ps1', 'dist/packages/office/automation.ps1');
await copyFile('apps/desktop/index.html', 'dist/desktop/index.html');
// The React layer's own stylesheet: the project palette and the rules for the DOM islands React only wraps.
await copyFile('apps/desktop/ui/styles.css', 'dist/desktop/ui.css');
await cp('apps/desktop/assets/icons', 'dist/desktop/assets/icons', { recursive: true });
await cp('apps/desktop/assets/new-tab', 'dist/desktop/assets/new-tab', { recursive: true });
// Runs under ordinary bundled Node, including from a copied maintenance directory.
await build({
  entryPoints: ['apps/desktop/upgrade-worker.ts'],
  outfile: 'dist/desktop/upgrade-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  ...commonJsModuleUrl,
});
await copyFile('package.json', 'dist/desktop/package-version.json');
await writeFile('dist/desktop/release.json', JSON.stringify({ maxSchemaVersion: SCHEMA_VERSION }));
await mkdir('dist/desktop/img', { recursive: true });
await Promise.all(
  ['logo-dark.png', 'logo-light.png'].map((name) =>
    copyFile(`apps/desktop/img/${name}`, `dist/desktop/img/${name}`),
  ),
);
console.log('[build] Desktop build complete.');
