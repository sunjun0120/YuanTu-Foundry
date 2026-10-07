/**
 * Build the web page: one browser bundle, and the desktop's own page around it.
 *
 * The page is not a second interface. `apps/desktop/index.html`, `styles.css` and `layout.css` are copied as they
 * are, and the only edit is the script tag — which is what "the second carrier reuses the interface layer" means
 * in practice. The bundle entry is `apps/web/page.ts`: it puts
 * the bridge on `window.yuantu` and then imports the same renderer the desktop loads.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const out = 'apps/web/dist';
await mkdir(`${out}/img`, { recursive: true });
await build({
  entryPoints: ['apps/web/page.ts'],
  outfile: `${out}/app.js`,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome140',
  sourcemap: true,
});
// The desktop's page, with its renderer script replaced by this bundle. `type="module"` because the bundle is
// ESM and because `page.ts` awaits the renderer import before the rest of the page can assume it ran.
const page = await readFile('apps/desktop/index.html', 'utf8');
const wired = page.replace(
  /<script src="\.\/renderer\.js"><\/script>/,
  '<script type="module" src="./app.js"></script>',
);
if (wired === page)
  throw new Error('index.html no longer loads ./renderer.js — update the web build');
await writeFile(`${out}/index.html`, wired, 'utf8');
await copyFile('apps/desktop/styles.css', `${out}/styles.css`);
await copyFile('apps/desktop/layout.css', `${out}/layout.css`);
await Promise.all(
  ['logo-dark.png', 'logo-light.png'].map((name) =>
    copyFile(`apps/desktop/img/${name}`, `${out}/img/${name}`),
  ),
);
console.log('[build] Web build complete.');
