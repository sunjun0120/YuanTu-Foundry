import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { SCHEMA_VERSION } from '../packages/storage/sqlite.ts';

await mkdir('dist/desktop', { recursive: true });
await build({
  entryPoints: [
    'apps/desktop/main.ts',
    'apps/desktop/attachment-worker.ts',
    'apps/desktop/preload.ts',
    'apps/desktop/mcp-test-worker.ts',
  ],
  outdir: 'dist/desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'pdfjs-dist/*'],
  sourcemap: true,
});
await build({
  entryPoints: ['apps/desktop/renderer.ts'],
  outfile: 'dist/desktop/renderer.js',
  bundle: true,
  platform: 'browser',
  target: 'chrome140',
  sourcemap: true,
});
await copyFile('packages/office/automation.ps1', 'dist/desktop/automation.ps1');
await mkdir('dist/packages/office', { recursive: true });
await copyFile('packages/office/automation.ps1', 'dist/packages/office/automation.ps1');
await copyFile('apps/desktop/index.html', 'dist/desktop/index.html');
await copyFile('apps/desktop/styles.css', 'dist/desktop/styles.css');
await copyFile('apps/desktop/layout.css', 'dist/desktop/layout.css');
// Runs under ordinary bundled Node, including from a copied maintenance directory.
await build({
  entryPoints: ['apps/desktop/upgrade-worker.ts'],
  outfile: 'dist/desktop/upgrade-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
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
