// @test-serial desktop-ui: Launches a real Electron window to time the React layer's transitions.
// Page swaps, rapid target changes, panel collapse, overlay transitions, and the reduced-motion contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const uiDir = path.join(projectRoot, 'apps/desktop/ui');
const ALIASES = {
  '@repo/primitives': path.join(uiDir, 'primitives.tsx'),
  '@repo/transitions': path.join(uiDir, 'transitions.tsx'),
  '@repo/reduced-motion': path.join(uiDir, 'reduced-motion.ts'),
  '@repo/app': path.join(uiDir, 'App.tsx'),
  '@repo/runtime': path.join(uiDir, 'runtime.ts'),
  '@repo/actions': path.join(uiDir, 'actions.ts'),
  '@repo/state': path.join(uiDir, 'ui-state.ts'),
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
 * The probe: two pages, a panel and a dialog, driven only by clicks.
 *
 * Every transition owner from `transitions.tsx` appears once, and nothing in the probe sets its own duration — the
 * test's frame recorder reads what the owners produced, which is the only way to tell the table from a call site.
 */
const ENTRY = `
import { useState } from 'react';
import { usePrefersReducedMotion } from '@repo/reduced-motion';
import { Dialog } from '@repo/primitives';
import { PageTransition, PanelTransition } from '@repo/transitions';
import { mountDesktopApp } from '@repo/app';
import { createDesktopRuntime } from '@repo/runtime';
import { createDesktopActions } from '@repo/actions';
import { createPendingOperations } from '@repo/state';

function MotionProbe() {
  const [view, setView] = useState('a');
  const [panel, setPanel] = useState(false);
  const [dialog, setDialog] = useState(false);
  const reduced = usePrefersReducedMotion();
  return (
    <div id="motion-probe" data-reduced={String(reduced)}>
      <button id="to-b" onClick={() => setView('b')}>b</button>
      <button id="to-c" onClick={() => setView('c')}>c</button>
      <button id="toggle-panel" onClick={() => setPanel((value) => !value)}>panel</button>
      <button id="open-dialog" onClick={() => setDialog(true)}>dialog</button>
      <Dialog opened={dialog} onClose={() => setDialog(false)} title="motion dialog">
        <div id="dialog-body">dialog body</div>
      </Dialog>
      <PageTransition viewKey={view} kind="page">
        <div id={'view-' + view} data-view={view} className="probe-view" style={{ height: 200 }}>
          {view}
        </div>
      </PageTransition>
      <PanelTransition opened={panel}>
        <div id="panel-body" style={{ height: 100, background: 'var(--raised)' }}>panel</div>
      </PanelTransition>
    </div>
  );
}

const bridge = { subscribe: () => () => {}, invoke: async () => ({ ok: true, state: {} }) };
mountDesktopApp({ children: <MotionProbe />,
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
`;

async function motionPage(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-motion-smoke-'));
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
    alias: ALIASES,
    logLevel: 'silent',
  });
  const fixtureJs = (bundle.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(fixtureJs, 'the motion probe bundle should build');
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
      `    <style nonce="${nonce}">html, body { margin: 0; }</style>`,
      '    <link rel="stylesheet" href="./renderer.css" />',
      '    <link rel="stylesheet" href="./ui.css" />',
      '  </head>',
      '  <body>',
      '    <div id="desktop-root"></div>',
      '    <div id="probe-mount"></div>',
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
      `  const win = new BrowserWindow({ show: true, width: 1000, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });\n` +
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
  await page.waitForSelector('#view-a');
  return page;
}

/** Record the transition state once per animation frame; the assertions read the timeline, not a final screenshot. */
async function recordFrames(page, count = 45) {
  await page.evaluate((frames) => {
    window.__frames = [];
    const read = () => ({
      panes: [...document.querySelectorAll('[data-page-pane]')].map((pane) => ({
        view: pane.querySelector('.probe-view')?.getAttribute('data-view') ?? null,
        inert: pane.querySelector('[inert]') !== null,
        opacity: Number(getComputedStyle(pane).opacity),
      })),
      panelHeight:
        document.getElementById('panel-body')?.parentElement?.getBoundingClientRect().height ?? 0,
    });
    const tick = () => {
      window.__frames.push(read());
      if (window.__frames.length < frames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, count);
}

async function frames(page) {
  return page.evaluate(() => window.__frames);
}

/** Wait until the page shows `view`, nothing is inert, and the enter animation has finished. */
async function settle(page, view) {
  await page.waitForFunction((expected) => {
    const pane = document.querySelector('[data-page-pane]');
    return (
      document.querySelector(`#view-${expected}`) !== null &&
      pane !== null &&
      pane.querySelector('[inert]') === null &&
      Number(getComputedStyle(pane).opacity) === 1
    );
  }, view);
}

/** The single pane's state, read after a settle rather than from a frame that may predate it. */
async function paneState(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-page-pane]');
    return {
      panes: [...document.querySelectorAll('[data-page-pane]')].map((pane) => ({
        view: pane.querySelector('.probe-view')?.getAttribute('data-view') ?? null,
        inert: pane.querySelector('[inert]') !== null,
        opacity: Number(getComputedStyle(pane).opacity),
      })),
      inner: pane === null ? null : pane.querySelector('.probe-view')?.getAttribute('data-view'),
    };
  });
}

test(
  'a page swap exits the old page inert and ends on the new one',
  { skip: electronSkip },
  async (t) => {
    const page = await motionPage(t);
    if (!page) return;
    await recordFrames(page);
    await page.locator('#to-b').click();
    await settle(page, 'b');
    const timeline = await frames(page);
    assert.ok(
      timeline.some((frame) => frame.panes.some((pane) => pane.inert)),
      'the outgoing pane spends at least one frame inert',
    );
    assert.ok(
      timeline.some((frame) => frame.panes.some((pane) => pane.opacity > 0 && pane.opacity < 1)),
      'the incoming pane fades in rather than appearing fully opaque',
    );
    assert.deepEqual((await paneState(page)).panes, [{ view: 'b', inert: false, opacity: 1 }]);
  },
);

test(
  'rapid A to B to C ends on C, without replaying the abandoned target',
  { skip: electronSkip },
  async (t) => {
    const page = await motionPage(t);
    if (!page) return;
    await page.locator('#to-b').click();
    await page.locator('#to-c').click();
    await settle(page, 'c');
    assert.deepEqual((await paneState(page)).panes, [{ view: 'c', inert: false, opacity: 1 }]);
    assert.equal(await page.locator('#view-a').count(), 0);
    assert.equal(await page.locator('#view-b').count(), 0);
  },
);

test(
  'a panel grows and collapses through the shared duration',
  { skip: electronSkip },
  async (t) => {
    const page = await motionPage(t);
    if (!page) return;
    const panel = () =>
      page.evaluate(() => {
        const wrapper = document.getElementById('panel-body')?.parentElement;
        return wrapper === null || wrapper === undefined
          ? null
          : {
              height: wrapper.getBoundingClientRect().height,
              duration: getComputedStyle(wrapper).transitionDuration,
            };
      });
    await page.locator('#toggle-panel').click();
    await page.waitForFunction(
      () =>
        (document.getElementById('panel-body')?.parentElement?.getBoundingClientRect().height ??
          0) > 99,
    );
    const opened = await panel();
    assert.ok(opened, 'the panel wrapper is missing');
    assert.ok(Math.abs(opened.height - 100) <= 1, `panel height ${opened.height}`);
    assert.match(opened.duration, /0\.18s/, 'the panel uses the 180ms table entry');
    await page.locator('#toggle-panel').click();
    await page.waitForFunction(
      () =>
        (document.getElementById('panel-body')?.parentElement?.getBoundingClientRect().height ??
          0) < 5,
    );
  },
);

test(
  'reduced motion reaches the final state without intermediate frames',
  { skip: electronSkip },
  async (t) => {
    const page = await motionPage(t);
    if (!page) return;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Wait for React's own hook to agree: clicking before `useReducedMotion` re-renders would start a real fade.
    await page.waitForFunction(
      () => document.getElementById('motion-probe')?.getAttribute('data-reduced') === 'true',
    );
    await recordFrames(page, 25);
    await page.locator('#to-b').click();
    await settle(page, 'b');
    const timeline = await frames(page);
    assert.ok(
      timeline.every((frame) =>
        frame.panes.every((pane) => !(pane.opacity > 0 && pane.opacity < 1)),
      ),
      'no pane fades under reduce',
    );
    assert.deepEqual((await paneState(page)).panes, [{ view: 'b', inert: false, opacity: 1 }]);

    await page.locator('#toggle-panel').click();
    await page.waitForFunction(
      () =>
        (document.getElementById('panel-body')?.parentElement?.getBoundingClientRect().height ??
          0) > 95,
    );
    const duration = await page.evaluate(
      () =>
        getComputedStyle(document.getElementById('panel-body').parentElement).transitionDuration,
    );
    // Mantine's duration-0 branch leaves no transition, and the CSS reduced-motion rule pins 0.01ms as a floor.
    assert.ok(Number.parseFloat(duration) < 0.001, `panel duration under reduce: ${duration}`);
  },
);

test(
  'switching to reduced motion mid-flight converges immediately',
  { skip: electronSkip },
  async (t) => {
    const page = await motionPage(t);
    if (!page) return;
    await page.locator('#to-b').click();
    await settle(page, 'b');
    await page.locator('#to-c').click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settle(page, 'c');
    assert.equal(await page.locator('#view-b').count(), 0);
    assert.deepEqual((await paneState(page)).panes, [{ view: 'c', inert: false, opacity: 1 }]);
  },
);
