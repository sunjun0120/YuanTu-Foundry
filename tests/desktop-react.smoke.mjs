// @test-serial desktop-ui: Launches a real Electron window to mount the React layer into the product page.
// The first React regions: one provider, portal mounting, translation isolation, the select upgrader, a dialog and
// the error boundary. The page under test is the product index.html (its CSP, nonce meta and stylesheet order),
// bundled with a probe component because no product region has moved yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const uiDir = path.join(projectRoot, 'apps/desktop/ui');

function installedElectron() {
  const root = path.join(projectRoot, 'node_modules/electron');
  try {
    const executable = path.join(root, 'dist', readFileSync(path.join(root, 'path.txt'), 'utf8'));
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}
const electronPath = installedElectron();
function electronLaunchProblem(executable) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env,
  });
  if (result.error) return `Electron could not start: ${result.error.message}`;
  if (result.status !== 0)
    return `Electron could not start (exit ${String(result.status ?? result.signal)})`;
  return undefined;
}
const electronSkip = electronPath
  ? electronLaunchProblem(electronPath)
  : 'the Electron binary is not installed (npx install-electron)';

/**
 * The probe: one region that exercises the primitives, the language store and the error boundary.
 *
 * The raw Chinese literal is deliberate. It is what proves the walker leaves React's subtree alone: after a switch
 * to English the legacy node is translated and this one still reads what React rendered, because React owns it.
 */
const ENTRY = `
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore, useState } from 'react';
import { Button, Dialog, Select, Stack, Text, TextInput } from '@repo/primitives';
import { mountDesktopApp } from '@repo/app';
import { mountRegion } from '@repo/regions';
import { locale, setLocale, t } from '@repo/i18n';
import { useLocale } from '@repo/ui-i18n';
import { createDesktopRuntime } from '@repo/runtime';
import { createDesktopActions } from '@repo/actions';
import { createPendingOperations } from '@repo/state';
import { setupSelectMenus } from '@repo/select-menu';

let explode = false;
const explodeListeners = new Set();
function setExplode(next) {
  explode = next;
  for (const listener of explodeListeners) listener();
}
function useExplode() {
  return useSyncExternalStore(
    (listener) => {
      explodeListeners.add(listener);
      return () => explodeListeners.delete(listener);
    },
    () => explode,
  );
}

function Probe() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [choice, setChoice] = useState(null);
  useLocale();
  const doomed = useExplode();
  if (doomed) throw new Error('probe exploded on purpose');
  return (
    <Stack gap="sm" p="md">
      <Text id="react-copy">{t('ui.newSession')}</Text>
      <Text id="react-raw">新建会话</Text>
      <TextInput id="react-input" label={t('ui.settings')} placeholder={t('ui.searchSessions')} />
      <Select
        id="react-select"
        label={t('ui.settings')}
        value={choice}
        onChange={setChoice}
        data={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
      />
      <Button id="react-button" onClick={() => setDialogOpen(true)}>
        {t('ui.settings')}
      </Button>
      <select id="react-native-select" defaultValue="a">
        <option value="a">A</option>
      </select>
      <Dialog opened={dialogOpen} onClose={() => setDialogOpen(false)} title={t('ui.settings')}>
        <Text id="dialog-body">{t('ui.newSession')}</Text>
      </Dialog>
    </Stack>
  );
}

const bridge = {
  subscribe: () => () => {},
  invoke: async () => ({ ok: true, state: {} }),
};
const runtime = createDesktopRuntime(bridge);
const actions = createDesktopActions({
  bridge,
  getState: () => null,
  setError: () => {},
  requestRender: () => {},
  isSending: () => false,
  clearComposer: () => {},
  focusPrompt: () => {},
  pending: createPendingOperations(),
});
mountDesktopApp({ runtime, actions });
setupSelectMenus();
mountRegion('probe', document.getElementById('probe-mount'), <Probe />);
window.__ui = { setLocale, locale, setExplode };
`;

async function probePage(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-react-smoke-'));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const entry = path.join(root, 'entry.tsx');
  await writeFile(entry, ENTRY, 'utf8');
  const bundle = await build({
    entryPoints: [entry],
    outfile: path.join(root, 'fixture.js'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [path.join(projectRoot, 'node_modules')],
    alias: {
      '@repo/primitives': path.join(uiDir, 'primitives.tsx'),
      '@repo/app': path.join(uiDir, 'App.tsx'),
      '@repo/regions': path.join(uiDir, 'legacy/mount-region.tsx'),
      '@repo/i18n': path.join(projectRoot, 'apps/desktop/i18n.ts'),
      '@repo/ui-i18n': path.join(uiDir, 'i18n.ts'),
      '@repo/runtime': path.join(uiDir, 'runtime.ts'),
      '@repo/actions': path.join(uiDir, 'actions.ts'),
      '@repo/state': path.join(uiDir, 'ui-state.ts'),
      '@repo/select-menu': path.join(projectRoot, 'apps/desktop/renderer-select-menu.ts'),
    },
    logLevel: 'silent',
  });
  const fixtureJs = (bundle.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(fixtureJs, 'the probe bundle should build');
  await writeFile(path.join(root, 'fixture.js'), fixtureJs, 'utf8');
  // The product stylesheets, as the build lays them out: the six legacy sheets beside index.html, Mantine's bundle
  // and the React layer's own sheet from dist.
  for (const sheet of [
    'styles.css',
    'styles-subagents.css',
    'styles-panels.css',
    'layout.css',
    'layout-surfaces.css',
    'layout-workspace.css',
  ])
    await copyFile(path.join(projectRoot, 'apps/desktop', sheet), path.join(root, sheet));
  await copyFile(
    path.join(projectRoot, 'dist/desktop/renderer.css'),
    path.join(root, 'renderer.css'),
  );
  await copyFile(path.join(projectRoot, 'dist/desktop/ui.css'), path.join(root, 'ui.css'));
  const product = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  const html = product
    .replace('<script src="./renderer.js"></script>', '<script src="./fixture.js"></script>')
    .replace(
      '    <div id="desktop-root"></div>',
      [
        '    <div id="desktop-root"></div>',
        '    <div id="legacy-copy">新建会话</div>',
        '    <select id="legacy-native-select"><option value="a">A</option></select>',
        '    <div id="probe-mount"></div>',
      ].join('\n'),
    );
  await writeFile(path.join(root, 'index.html'), html);
  const main = path.join(root, 'main.cjs');
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron');\n` +
      `app.whenReady().then(() => {\n` +
      `  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });\n` +
      `  win.loadFile(${JSON.stringify(path.join(root, 'index.html'))});\n` +
      `});\n` +
      `app.on('window-all-closed', () => app.quit());\n`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await electron.launch({
      executablePath: String(electronPath),
      args: [main, `--user-data-dir=${path.join(root, 'profile')}`],
      env,
    });
  } catch (error) {
    t.skip(`Electron could not launch on this host: ${error.message}`);
    return null;
  }
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  return page;
}

test('the build ships both stylesheets in the documented order', async () => {
  for (const file of ['dist/desktop/renderer.css', 'dist/desktop/ui.css'])
    assert.ok(existsSync(path.join(projectRoot, file)), `${file} should exist after npm run build`);
  const html = await readFile(path.join(projectRoot, 'dist/desktop/index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)" \/>/g)].map(
    (match) => match[1],
  );
  assert.equal(links[0], 'renderer.css');
  assert.equal(links.at(-1), 'ui.css');
  assert.deepEqual(links.slice(1, -1), [
    'styles.css',
    'styles-subagents.css',
    'styles-panels.css',
    'layout.css',
    'layout-surfaces.css',
    'layout-workspace.css',
  ]);
  assert.match(html, /<div id="desktop-root"><\/div>/);
});

test('the React layer mounts into the product document', { skip: electronSkip }, async (t) => {
  const page = await probePage(t);
  if (!page) return;
  await page.waitForSelector('#react-copy');

  const mounted = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('desktop-root')).display,
    owned: document.getElementById('probe-mount').hasAttribute('data-react-owned'),
    bodyVariable: getComputedStyle(document.documentElement)
      .getPropertyValue('--mantine-color-body')
      .trim(),
    buttonBackground: getComputedStyle(document.getElementById('react-button')).backgroundColor,
    noncedStyles: [...document.querySelectorAll('style[data-mantine-styles]')].every(
      (style) => style.getAttribute('nonce') !== null,
    ),
    legacyUpgraded:
      document.getElementById('legacy-native-select').closest('.select-menu') !== null,
    reactUpgraded: document.getElementById('react-native-select').closest('.select-menu') !== null,
    reactStillSelect: document.getElementById('react-native-select').tagName,
  }));
  assert.equal(mounted.display, 'contents', 'the portal host must not become a layout box');
  assert.equal(mounted.owned, true, 'the mounted container is marked as React-owned');
  assert.notEqual(mounted.bodyVariable, '', 'the provider injects its CSS variables');
  assert.notEqual(mounted.buttonBackground, 'rgba(0, 0, 0, 0)', 'Mantine styles the button');
  assert.equal(mounted.noncedStyles, true, 'every injected stylesheet carries the CSP nonce');
  assert.equal(mounted.legacyUpgraded, true, 'a legacy select is still upgraded');
  assert.equal(mounted.reactUpgraded, false, 'a select inside a React region is left alone');
  assert.equal(mounted.reactStillSelect, 'SELECT');

  // Language: the walker translates the legacy node, React re-renders through useLocale, and the walker leaves
  // the React-owned raw text exactly as React rendered it.
  assert.equal(await page.locator('#legacy-copy').innerText(), '新建会话');
  await page.evaluate(() => window.__ui.setLocale('en-US'));
  await page.waitForFunction(
    () => document.getElementById('legacy-copy').textContent === 'New session',
  );
  assert.equal(await page.locator('#react-copy').innerText(), 'New session');
  assert.equal(await page.locator('#react-raw').innerText(), '新建会话');
  assert.equal(await page.locator('#react-input').getAttribute('placeholder'), 'Search sessions');
  await page.evaluate(() => window.__ui.setLocale('zh-CN'));
  await page.waitForFunction(
    () => document.getElementById('legacy-copy').textContent === '新建会话',
  );

  // The dialog is Mantine's modal: opens from React, closes on Escape.
  await page.locator('#react-button').click();
  await page.waitForSelector('#dialog-body');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('dialog-body') === null);

  // The error boundary says what happened in the interface language and offers the retry that remounts the region.
  await page.evaluate(() => window.__ui.setLocale('en-US'));
  await page.evaluate(() => window.__ui.setExplode(true));
  await page.waitForSelector('[data-ui-error]');
  assert.match(await page.locator('[data-ui-error]').innerText(), /failed to render/i);
  await page.evaluate(() => window.__ui.setExplode(false));
  await page.locator('[data-ui-error] button').click();
  await page.waitForSelector('#react-copy');
  assert.equal(await page.locator('#react-copy').innerText(), 'New session');
});
