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
/** Repo entry points under names a temporary fixture can import; relative paths would not resolve across drives. */
const REPO_ALIASES = {
  '@repo/primitives': path.join(uiDir, 'primitives.tsx'),
  '@repo/app': path.join(uiDir, 'App.tsx'),
  '@repo/shell': path.join(uiDir, 'layout/DesktopShell.tsx'),
  '@repo/i18n': path.join(projectRoot, 'apps/desktop/i18n.ts'),
  '@repo/ui-i18n': path.join(uiDir, 'i18n.ts'),
  '@repo/runtime': path.join(uiDir, 'runtime.ts'),
  '@repo/actions': path.join(uiDir, 'actions.ts'),
  '@repo/state': path.join(uiDir, 'ui-state.ts'),
  '@repo/settings': path.join(uiDir, 'settings/GeneralSettings.tsx'),
  '@repo/settings-model': path.join(uiDir, 'settings/settings-model.ts'),
};

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
import { locale, setLocale, t } from '@repo/i18n';
import { useLocale } from '@repo/ui-i18n';
import { createDesktopRuntime } from '@repo/runtime';
import { createDesktopActions } from '@repo/actions';
import { createPendingOperations } from '@repo/state';

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
      <div id="surface-probe" style={{ background: 'var(--surface)', width: 16, height: 16 }} />
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
const disposeApp = mountDesktopApp({ children: <div id="probe-mount" data-react-owned=""><Probe /></div>, runtime, actions,
  initialize: () => {
    if (!document.getElementById('probe-mount')) throw new Error('application initialized before its hosts');
    window.__starts = (window.__starts || 0) + 1;
    const ticker = setInterval(() => { window.__ticks = (window.__ticks || 0) + 1; }, 10);
    return () => { clearInterval(ticker); window.__stops = (window.__stops || 0) + 1; };
  },
});
window.__ui = { setLocale, locale, setExplode, disposeApp };
`;

/**
 * The shell probe: one AppShell with the three regions, on a page that has no legacy CSS at all.
 *
 * That is the point of a separate fixture — the shell must stand on Mantine's own stylesheet, since the six legacy
 * sheets are what T24 deletes. The aside is toggled from outside React so the test can check the layout offset it
 * causes, and the main content is tall so the scroll container can be identified.
 */
const SHELL_ENTRY = `
import { useSyncExternalStore } from 'react';
import { mountDesktopApp } from '@repo/app';
import { DesktopShell } from '@repo/shell';
import { createDesktopRuntime } from '@repo/runtime';
import { createDesktopActions } from '@repo/actions';
import { createPendingOperations } from '@repo/state';

let asideVisible = false;
const listeners = new Set();
function setAside(next) {
  asideVisible = next;
  for (const listener of listeners) listener();
}
function useAside() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => asideVisible,
  );
}

function ShellProbe() {
  const visible = useAside();
  return (
    <DesktopShell
      navbar={<div id="nav-probe">nav</div>}
      aside={<div id="aside-probe">aside</div>}
      asideVisible={visible}
      main={<div id="main-content" style={{ height: 2400 }}>main</div>}
    />
  );
}

const bridge = { subscribe: () => () => {}, invoke: async () => ({ ok: true, state: {} }) };
mountDesktopApp({ children: <ShellProbe />,
  runtime: createDesktopRuntime(bridge),
  actions: createDesktopActions({
    bridge,
    getState: () => null,
    setError: () => {},
    requestRender: () => {},
    isSending: () => false,
    clearComposer: () => {},
    focusPrompt: () => {},
    pending: createPendingOperations(),
  }),
});
window.__ui = { setAside };
`;

/**
 * The general settings form over a bridge whose saves are refused.
 *
 * The controller's save queue is unit-tested, but the wiring between it and the controls is not: a refused save has
 * to reach the screen as a message and put the control back to the stored value. Only a real render can show that.
 */
const SETTINGS_ENTRY = `
import { useEffect, useMemo } from 'react';
import { mountDesktopApp } from '@repo/app';
import { createDesktopRuntime } from '@repo/runtime';
import { createDesktopActions } from '@repo/actions';
import { createPendingOperations } from '@repo/state';
import { GeneralSettings } from '@repo/settings';
import { createGeneralSettingsController } from '@repo/settings-model';

const stored = {
  language: 'zh-CN',
  appearance: 'system',
  fontSize: 'medium',
  notifications: true,
};
const bridge = { subscribe: () => () => {}, invoke: async () => ({ ok: true, state: {} }) };
mountDesktopApp({ children: <SettingsProbe />,
  runtime: createDesktopRuntime(bridge),
  actions: createDesktopActions({
    bridge,
    getState: () => null,
    setError: () => {},
    requestRender: () => {},
    isSending: () => false,
    clearComposer: () => {},
    focusPrompt: () => {},
    pending: createPendingOperations(),
  }),
});

function SettingsProbe() {
  const controller = useMemo(
    () =>
      createGeneralSettingsController({
        bridge: {
          uiSettings: async (command) =>
            command.type === 'get'
              ? { ok: true, kind: 'settings', settings: stored }
              : { ok: false, error: 'save refused by test' },
        },
        apply: () => {},
      }),
    [],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  return <GeneralSettings controller={controller} />;
}

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
    alias: REPO_ALIASES,
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
      '    <div id="desktop-root" class="desktop-root"></div>',
      [
        '    <div id="desktop-root" class="desktop-root"></div>',
        '    <div id="legacy-copy">新建会话</div>',
        '    <select id="legacy-native-select"><option value="a">A</option></select>',
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
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1200, height: 800 });
  return page;
}

/** A minimal page with the product CSP and only the two stylesheets the React layer owns. */
async function shellPage(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-shell-smoke-'));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const entry = path.join(root, 'shell.tsx');
  await writeFile(entry, SHELL_ENTRY, 'utf8');
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
    alias: REPO_ALIASES,
    logLevel: 'silent',
  });
  const fixtureJs = (bundle.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(fixtureJs, 'the shell bundle should build');
  await writeFile(path.join(root, 'fixture.js'), fixtureJs, 'utf8');
  await copyFile(
    path.join(projectRoot, 'dist/desktop/renderer.css'),
    path.join(root, 'renderer.css'),
  );
  await copyFile(path.join(projectRoot, 'dist/desktop/ui.css'), path.join(root, 'ui.css'));
  const product = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  const csp = /content="(default-src[^"]+)"/.exec(product)?.[1];
  const nonce = /<meta name="yuantu-style-nonce" content="([^"]+)"/.exec(product)?.[1];
  assert.ok(csp && nonce, 'the product document owns the CSP and nonce this fixture must reuse');
  await writeFile(
    path.join(root, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="zh-CN" data-theme="dark">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      `    <meta name="yuantu-style-nonce" content="${nonce}" />`,
      `    <style nonce="${nonce}">html, body { margin: 0; height: 100%; }</style>`,
      '    <link rel="stylesheet" href="./renderer.css" />',
      '    <link rel="stylesheet" href="./ui.css" />',
      '  </head>',
      '  <body>',
      '    <div id="desktop-root"></div>',
      '    <div id="shell-mount"></div>',
      '    <script src="./fixture.js"></script>',
      '  </body>',
      '</html>',
    ].join('\n'),
    'utf8',
  );
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
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1200, height: 800 });
  return page;
}

/** A one-panel page for the settings form; the product document's CSP and nonce are reused. */
async function settingsPage(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settings-smoke-'));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const entry = path.join(root, 'settings.tsx');
  await writeFile(entry, SETTINGS_ENTRY, 'utf8');
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
    alias: REPO_ALIASES,
    logLevel: 'silent',
  });
  const fixtureJs = (bundle.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(fixtureJs, 'the settings bundle should build');
  await writeFile(path.join(root, 'fixture.js'), fixtureJs, 'utf8');
  await copyFile(
    path.join(projectRoot, 'dist/desktop/renderer.css'),
    path.join(root, 'renderer.css'),
  );
  await copyFile(path.join(projectRoot, 'dist/desktop/ui.css'), path.join(root, 'ui.css'));
  const product = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  const csp = /content="(default-src[^"]+)"/.exec(product)?.[1];
  const nonce = /<meta name="yuantu-style-nonce" content="([^"]+)"/.exec(product)?.[1];
  assert.ok(csp && nonce, 'the product document owns the CSP and nonce this fixture must reuse');
  await writeFile(
    path.join(root, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="zh-CN" data-theme="dark">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      `    <meta name="yuantu-style-nonce" content="${nonce}" />`,
      `    <style nonce="${nonce}">html, body { margin: 0; padding: 16px; }</style>`,
      '    <link rel="stylesheet" href="./renderer.css" />',
      '    <link rel="stylesheet" href="./ui.css" />',
      '  </head>',
      '  <body>',
      '    <div id="desktop-root"></div>',
      '    <div id="settings-mount"></div>',
      '    <script src="./fixture.js"></script>',
      '  </body>',
      '</html>',
    ].join('\n'),
    'utf8',
  );
  const main = path.join(root, 'main.cjs');
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron');\n` +
      `app.whenReady().then(() => {\n` +
      `  const win = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });\n` +
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
  return app.firstWindow();
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
  assert.deepEqual(links, ['renderer.css', 'ui.css']);
  assert.match(html, /<div id="desktop-root"[^>]*><\/div>/);
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
  assert.equal(mounted.display, 'block', 'the application root owns the window layout');
  assert.equal(mounted.owned, true, 'the mounted container is marked as React-owned');
  assert.notEqual(mounted.bodyVariable, '', 'the provider injects its CSS variables');
  assert.notEqual(mounted.buttonBackground, 'rgba(0, 0, 0, 0)', 'Mantine styles the button');
  assert.equal(mounted.noncedStyles, true, 'every injected stylesheet carries the CSP nonce');
  assert.equal(mounted.legacyUpgraded, false, 'global select mutation has been retired');
  assert.equal(mounted.reactUpgraded, false, 'a select inside a React region is left alone');
  assert.equal(mounted.reactStillSelect, 'SELECT');

  // Appearance: the provider follows the same `data-theme` the settings controller writes, not a store of its own.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark',
  );
  await page.locator('#react-button').click();
  await page.waitForSelector('#dialog-body');
  const darkColours = await page.evaluate(() => ({
    surface: getComputedStyle(document.getElementById('surface-probe')).backgroundColor,
    modal: getComputedStyle(document.querySelector('.mantine-Modal-content')).backgroundColor,
    stored: localStorage.getItem('mantine-color-scheme-value'),
  }));
  assert.equal(darkColours.modal, darkColours.surface, 'the portal body uses the project surface');
  assert.equal(darkColours.stored, null, 'the appearance is not copied into localStorage');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('dialog-body') === null);

  // `system` follows the OS; an explicit choice does not.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'system';
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'light',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(
    await page.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme')),
    'dark',
    'an explicit dark choice ignores the system preference',
  );

  // Text size scales Mantine's variables from the same attribute the settings page writes.
  const fontSizeVariable = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--mantine-font-size-md').trim(),
    );
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = 'large';
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--mantine-font-size-md')
        .trim() === '16px',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = 'small';
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--mantine-font-size-md')
        .trim() === '13px',
  );
  assert.equal(await fontSizeVariable(), '13px');

  // Language: the walker translates the legacy node, React re-renders through useLocale, and the walker leaves
  // the React-owned raw text exactly as React rendered it.
  assert.equal(await page.locator('#legacy-copy').innerText(), '新建会话');
  await page.evaluate(() => window.__ui.setLocale('en-US'));
  await page.waitForFunction(
    () => document.getElementById('react-copy').textContent === 'New session',
  );
  assert.equal(await page.locator('#react-copy').innerText(), 'New session');
  assert.equal(
    await page.locator('#legacy-copy').innerText(),
    '新建会话',
    'locale changes do not rewrite unrelated DOM',
  );
  assert.equal(await page.locator('#react-raw').innerText(), '新建会话');
  assert.equal(await page.locator('#react-input').getAttribute('placeholder'), 'Search sessions');
  await page.evaluate(() => window.__ui.setLocale('zh-CN'));
  await page.waitForFunction(
    () => document.getElementById('legacy-copy').textContent === '新建会话',
  );

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

test(
  'application lifetime starts after its hosts and stops its ticker exactly once',
  { skip: electronSkip },
  async (t) => {
    const page = await probePage(t);
    if (!page) return;
    await page.waitForSelector('#react-copy');
    assert.equal(await page.evaluate(() => window.__starts), 1);
    await page.evaluate(() => {
      window.__ui.disposeApp();
      window.__ui.disposeApp();
    });
    const stopped = await page.evaluate(() => ({
      stops: window.__stops,
      ticks: window.__ticks,
      nodes: document.getElementById('desktop-root').childElementCount,
    }));
    assert.equal(stopped.stops, 1);
    assert.equal(stopped.nodes, 0);
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => window.__ticks), stopped.ticks);
    await page.evaluate(() => window.__ui.setLocale('en-US'));
  },
);

test(
  'the shell is one AppShell with one main and one scroll container',
  { skip: electronSkip },
  async (t) => {
    const page = await shellPage(t);
    if (!page) return;
    await page.waitForSelector('#nav-probe');

    const initial = await page.evaluate(() => {
      const navbar = document.querySelector('.mantine-AppShell-navbar');
      const main = document.querySelector('.mantine-AppShell-main');
      const content = document.querySelector('.desktop-shell-content');
      return {
        mains: document.querySelectorAll('main').length,
        roots: document.querySelectorAll('.mantine-AppShell-root').length,
        navbarWidth: navbar === null ? 0 : navbar.getBoundingClientRect().width,
        mainHeight: main === null ? 0 : main.clientHeight,
        viewport: window.innerHeight,
        asideWidth: document.getElementById('aside-probe')?.offsetWidth ?? 0,
        contentScrolls: content !== null && content.scrollHeight > content.clientHeight,
        windowScroll: document.scrollingElement.scrollHeight - window.innerHeight,
      };
    });
    assert.equal(initial.mains, 1, 'the window has one main landmark');
    assert.equal(initial.roots, 1, 'the shell is exactly one AppShell');
    assert.ok(Math.abs(initial.navbarWidth - 264) <= 1, `navbar width ${initial.navbarWidth}`);
    assert.ok(
      Math.abs(initial.mainHeight - initial.viewport) <= 1,
      `main height ${initial.mainHeight} vs viewport ${initial.viewport}`,
    );
    assert.equal(initial.asideWidth, 0, 'the aside starts collapsed');
    assert.equal(initial.contentScrolls, true, 'the main column is the scroll container');
    assert.equal(initial.windowScroll, 0, 'the window itself does not scroll');

    await page.evaluate(() => window.__ui.setAside(true));
    await page.waitForFunction(
      () => (document.getElementById('aside-probe')?.offsetWidth ?? 0) > 0,
    );
    const withAside = await page.evaluate(() => ({
      asideWidth: document.getElementById('aside-probe').offsetWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      mains: document.querySelectorAll('main').length,
    }));
    assert.ok(Math.abs(withAside.asideWidth - 360) <= 1, `aside width ${withAside.asideWidth}`);
    assert.ok(withAside.overflow <= 0, 'the aside offsets content instead of overflowing');
    assert.equal(withAside.mains, 1);

    // The window's smallest supported width must still be one column with no horizontal scroll.
    await page.setViewportSize({ width: 820, height: 560 });
    const small = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      mains: document.querySelectorAll('main').length,
      mainHeight: document.querySelector('.mantine-AppShell-main').clientHeight,
    }));
    assert.ok(small.overflow <= 0, `horizontal overflow ${small.overflow} at 820px`);
    assert.equal(small.mains, 1);
    assert.ok(
      Math.abs(small.mainHeight - 560) <= 1,
      'the shell keeps the window height when it shrinks',
    );
  },
);

test(
  'a refused general-settings save shows its reason and rolls the control back',
  { skip: electronSkip },
  async (t) => {
    const page = await settingsPage(t);
    if (!page) return;
    await page.waitForSelector('#ui-appearance');
    assert.equal(await page.locator('#ui-appearance').inputValue(), '跟随系统');
    await page.locator('#ui-appearance').click();
    await page.getByRole('option', { name: '深色', exact: true }).click();
    const alert = page.locator('[data-settings-error]');
    await alert.waitFor();
    assert.match(await alert.innerText(), /save refused by test/);
    // The form must never show a value that is not stored: the refusal puts the control back.
    await page.waitForFunction(
      () => document.querySelector('#ui-appearance')?.value === '跟随系统',
    );
    assert.equal(await page.locator('#ui-appearance').inputValue(), '跟随系统');
  },
);
