// @test-serial desktop-ui: Launches a real Electron window to prove the product CSP authorises Mantine's styles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { STYLE_NONCE_META, UI_STYLE_NONCE } from '../apps/desktop/ui/nonce.ts';
import { projectRoot } from './process-fixture.ts';

/**
 * The product CSP against the real Mantine tree.
 *
 * The static stylesheet and the six legacy sheets are plain `<link>`s, but Mantine also injects `<style>` elements
 * at runtime: the theme's CSS variables, the global breakpoint classes, and the responsive rules `Box` emits for
 * style props. `style-src` refuses all three unless they carry the document's nonce, and a page whose styles are
 * refused still loads — it just renders unstyled, which no unit test notices. So this file builds a page from the
 * product `index.html` (CSP and nonce meta included), loads it through `file:` in Electron exactly as the product
 * does, renders a small Mantine tree, and checks both directions:
 *
 * - the authorised styles take effect (variables, AppShell, responsive `Box`);
 * - a `<style>` without the nonce and an inline `<script>` are refused.
 */
function installedElectron(): string | undefined {
  const root = path.join(projectRoot, 'node_modules', 'electron');
  try {
    const executable = path.join(root, 'dist', readFileSync(path.join(root, 'path.txt'), 'utf8'));
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}
const electronPath = installedElectron();
function electronLaunchProblem(executable: string): string | undefined {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
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

test('the document authorises exactly the nonce the application declares', async () => {
  const html = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  const csp = /content="(default-src[^"]+)"/.exec(html)?.[1];
  assert.ok(csp, 'index.html must declare a Content-Security-Policy meta');
  assert.match(csp, new RegExp(`style-src 'self' data: 'nonce-${UI_STYLE_NONCE}'`));
  assert.match(csp, /script-src 'self'/);
  assert.equal(csp.includes('unsafe-inline'), false, 'the CSP must not authorise inline anything');
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal((csp.match(/'nonce-/g) ?? []).length, 1, 'one directive carries the nonce');
  const meta = new RegExp(`<meta name="${STYLE_NONCE_META}" content="([^"]+)"`).exec(html)?.[1];
  assert.equal(meta, UI_STYLE_NONCE, 'the meta and the CSP must name the same nonce');
});

/** The probe page: the product document, a Mantine tree, one unauthorised style and one inline script. */
async function probePage(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-csp-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  // One hook for both: the window has to be closed before the profile directory can be removed (Windows refuses
  // to unlink a file Electron still holds), and `t.after` runs in registration order.
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const entry = path.join(root, 'entry.tsx');
  await writeFile(
    entry,
    [
      "import { createRoot } from 'react-dom/client';",
      "import { AppShell, Box, Button, Grid, Group, MantineProvider, Popover, Stack, Text, Title } from '@mantine/core';",
      "import { styleNonceFromDocument } from '@yuantu/nonce';",
      '',
      'document.addEventListener("securitypolicyviolation", () => {',
      '  (window as unknown as { violations: string[] }).violations ??= [];',
      '  (window as unknown as { violations: string[] }).violations.push("violation");',
      '});',
      'const nonce = styleNonceFromDocument(document);',
      '(window as unknown as { __nonce: string }).__nonce = nonce;',
      '',
      'function Probe() {',
      '  return (',
      '    <MantineProvider getStyleNonce={() => nonce} forceColorScheme="dark">',
      '      <AppShell navbar={{ width: 120, breakpoint: "sm" }} header={{ height: 40 }}>',
      '        <AppShell.Header>header</AppShell.Header>',
      '        <AppShell.Navbar>nav</AppShell.Navbar>',
      '        <AppShell.Main>',
      '          <Stack>',
      '            <Title order={2} id="probe-title">probe</Title>',
      '            <Grid><Grid.Col span={6}><Text id="probe-text">hello</Text></Grid.Col></Grid>',
      '            <Box id="probe-box" w={{ base: 100, md: 200 }}>box</Box>',
      '            <Group>',
      '              <Popover opened position="bottom-start">',
      '                <Popover.Target><Button id="probe-button">open</Button></Popover.Target>',
      '                <Popover.Dropdown id="probe-dropdown">menu</Popover.Dropdown>',
      '              </Popover>',
      '            </Group>',
      '          </Stack>',
      '        </AppShell.Main>',
      '      </AppShell>',
      '    </MantineProvider>',
      '  );',
      '}',
      '',
      '// The second root turns on React 19 style hoisting for the responsive rules, which is a different element',
      '// shape (`<style href precedence nonce>`) and therefore a different path through the same nonce.',
      'function DeduplicatedProbe() {',
      '  return (',
      '    <MantineProvider getStyleNonce={() => nonce} deduplicateInlineStyles forceColorScheme="dark">',
      '      <Box id="probe-dedup-box" w={{ base: 50, md: 300 }}>dedup</Box>',
      '    </MantineProvider>',
      '  );',
      '}',
      '',
      "createRoot(document.getElementById('probe-root')!).render(<Probe />);",
      "createRoot(document.getElementById('probe-root-dedup')!).render(<DeduplicatedProbe />);",
      '(window as unknown as { __reactRan: boolean }).__reactRan = true;',
      '',
    ].join('\n'),
  );
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
    alias: { '@yuantu/nonce': path.join(projectRoot, 'apps/desktop/ui/nonce.ts') },
    logLevel: 'silent',
  });
  // Written by this process rather than by esbuild's service: the test sandbox refuses the service's own write.
  const fixtureJs = (bundle.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(fixtureJs, 'the probe bundle should build');
  await writeFile(path.join(root, 'fixture.js'), fixtureJs, 'utf8');
  const mantineCss = await readFile(
    path.join(projectRoot, 'node_modules/@mantine/core/styles.css'),
    'utf8',
  );
  await writeFile(path.join(root, 'mantine.css'), mantineCss);
  const product = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  const html = product
    .replace(/^\s*<link rel="stylesheet" href="\.\/[^"]+" \/>\n/gm, '')
    .replace(/^\s*<script src="\.\/renderer\.js"><\/script>\n/gm, '')
    .replace(
      '</head>',
      [
        '    <link rel="stylesheet" href="./mantine.css" />',
        '    <style id="probe-unauthorized">#probe-unauthorized-target { color: rgb(9, 9, 9); }</style>',
        '    <script>window.__inlineRan = true;</script>',
        '  </head>',
      ].join('\n'),
    )
    .replace(
      '</body>',
      [
        '    <div id="probe-root"></div>',
        '    <div id="probe-root-dedup"></div>',
        '    <div id="probe-unauthorized-target">blocked</div>',
        '    <script src="./fixture.js"></script>',
        '  </body>',
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
  const env = Object.fromEntries(
    Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await electron.launch({
      executablePath: String(electronPath),
      args: [main, `--user-data-dir=${path.join(root, 'profile')}`],
      env,
    });
  } catch (error) {
    t.skip(
      `Electron could not launch on this host: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  return page;
}

test(
  'the authorised styles apply and unauthorised ones are refused',
  { skip: electronSkip },
  async (t) => {
    const page = await probePage(t);
    if (!page) return;
    await page.waitForSelector('#probe-title');
    const probe = await page.evaluate(() => {
      const styleTags = [...document.querySelectorAll('style')];
      const mantineStyles = styleTags.filter((style) => style.hasAttribute('data-mantine-styles'));
      const unauthorized = document.getElementById('probe-unauthorized-target');
      const box = document.getElementById('probe-box');
      const dedupBox = document.getElementById('probe-dedup-box');
      const main = document.querySelector('.mantine-AppShell-main');
      return {
        nonceFromDocument: (window as unknown as { __nonce: string }).__nonce,
        reactRan: (window as unknown as { __reactRan?: boolean }).__reactRan ?? false,
        inlineRan: (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false,
        violations: (window as unknown as { violations?: string[] }).violations ?? [],
        mantineStyleCount: mantineStyles.length,
        mantineNonced: mantineStyles.every((style) => style.getAttribute('nonce') !== null),
        inlineStyleNonced: styleTags
          .filter((style) => style.getAttribute('data-mantine-styles') === 'inline')
          .every((style) => style.getAttribute('nonce') !== null),
        // React 19 hoists `href`/`precedence` styles into <head> as `data-href`/`data-precedence`;
        // Mantine passes the nonce on that element too.
        hoistedNonces: [...document.head.querySelectorAll('style[data-precedence]')].map((style) =>
          style.getAttribute('nonce'),
        ),
        bodyVariable: getComputedStyle(document.documentElement)
          .getPropertyValue('--mantine-color-body')
          .trim(),
        colorScheme: document.documentElement.getAttribute('data-mantine-color-scheme'),
        mainHeight: main === null ? null : getComputedStyle(main).minHeight,
        boxWidth: box === null ? null : getComputedStyle(box).width,
        dedupBoxWidth: dedupBox === null ? null : getComputedStyle(dedupBox).width,
        unauthorizedColor: unauthorized === null ? null : getComputedStyle(unauthorized).color,
      };
    });
    assert.equal(
      probe.nonceFromDocument,
      UI_STYLE_NONCE,
      'the page reads the nonce from its own meta',
    );
    assert.equal(probe.reactRan, true, 'a same-origin script runs under script-src self');
    assert.equal(probe.inlineRan, false, 'an inline script stays blocked');
    assert.ok(probe.mantineStyleCount >= 2, 'Mantine injects its variables and classes');
    assert.equal(probe.mantineNonced, true, 'every injected style carries the nonce');
    assert.equal(probe.inlineStyleNonced, true, 'the responsive Box rules carry the nonce too');
    assert.ok(probe.hoistedNonces.length >= 1, 'React hoists the deduplicated style element');
    assert.ok(
      probe.hoistedNonces.every((nonce) => nonce === UI_STYLE_NONCE),
      'the hoisted style carries the same nonce',
    );
    assert.notEqual(probe.bodyVariable, '', 'CSS variables are applied');
    assert.equal(probe.colorScheme, 'dark', 'the provider drives the colour scheme attribute');
    assert.equal(probe.boxWidth, '200px', 'the responsive Box rule applies at this width');
    assert.equal(probe.dedupBoxWidth, '300px', 'the hoisted responsive rule applies too');
    assert.notEqual(probe.unauthorizedColor, 'rgb(9, 9, 9)', 'the nonce-less style is refused');
    assert.deepEqual(probe.violations, [], 'nothing else is refused after the probe starts');
  },
);
