/**
 * The desktop React migration's acceptance evidence, collected in one run.
 *
 * The plan's final task asks for things a test assertion cannot photograph: theme, language, text size and window
 * screenshots, motion frames, resource sizes with a pre-migration baseline, cold-start and long-history timings, and a
 * check that the built document still loads only local stylesheets. This script produces all of it under
 * `artifacts/desktop-react-acceptance-<date>/` together with a `summary.json` the delivery record quotes.
 *
 * Run after `npm run build`. It launches the real desktop, so it is a local/manual step rather than part of `npm test`:
 *   npm run build
 *   npm run acceptance:desktop
 */
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { scanI18n, withoutComments } from './i18n-gate.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stamp = new Date().toISOString().slice(0, 10);
const out = path.resolve(
  root,
  process.env.FOUNDRY_ACCEPTANCE_OUT ?? `artifacts/desktop-react-acceptance-${stamp}`,
);
const shots = path.join(out, 'screens');
const LEGACY_SHEETS = [
  'styles.css',
  'styles-panels.css',
  'styles-subagents.css',
  'layout.css',
  'layout-surfaces.css',
  'layout-workspace.css',
];

const summary = { generatedAt: new Date().toISOString(), screens: [], metrics: {}, limits: [] };

async function measure(file) {
  const text = await readFile(path.join(root, file), 'utf8');
  return {
    file,
    bytes: Buffer.byteLength(text),
    lines: text.trimEnd().split('\n').length,
    important: (text.match(/!important/g) ?? []).length,
  };
}

async function size(file) {
  try {
    return (await stat(path.join(root, file))).size;
  } catch {
    return null;
  }
}

/** The shipped document must reference only local files and keep the CSP it was audited with. */
async function documentFacts() {
  const html = await readFile(path.join(root, 'apps/desktop/index.html'), 'utf8');
  const csp = /content="(default-src[^"]+)"/.exec(html)?.[1] ?? '';
  return {
    links: [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]),
    externalRequests: /(?:src|href)="https?:/.test(html),
    csp,
    insecure: /unsafe-inline|unsafe-eval/.test(csp),
    scriptSrc: /script-src 'self'/.test(csp),
    nonceCount: [...html.matchAll(/nonce-/g)].length,
  };
}

async function staticMetrics() {
  const legacy = await Promise.all(LEGACY_SHEETS.map((name) => measure(`apps/desktop/${name}`)));
  const ui = await measure('apps/desktop/ui/styles.css');
  const i18nProblems = await scanI18n(root);
  const baselineDir = path.join(root, 'dist/release/win-unpacked/resources/app/dist/desktop');
  let baseline = null;
  try {
    const files = await readdir(baselineDir);
    baseline = {
      dir: path.relative(root, baselineDir),
      rendererJs: (await stat(path.join(baselineDir, 'renderer.js'))).size,
      indexHtml: (await stat(path.join(baselineDir, 'index.html'))).size,
      legacySheets: files.filter((name) => LEGACY_SHEETS.includes(name)).length,
      uiCss: files.includes('ui.css'),
    };
  } catch {
    baseline = null;
  }
  return {
    legacyCss: {
      files: legacy,
      totalLines: legacy.reduce((sum, entry) => sum + entry.lines, 0),
      totalImportant: legacy.reduce((sum, entry) => sum + entry.important, 0),
    },
    uiCss: ui,
    i18n: { problems: i18nProblems.length, sample: i18nProblems.slice(0, 5) },
    bundle: {
      rendererJs: await size('dist/desktop/renderer.js'),
      rendererCss: await size('dist/desktop/renderer.css'),
      uiCss: await size('dist/desktop/ui.css'),
      indexHtml: await size('dist/desktop/index.html'),
    },
    preMigrationBundle: baseline,
    document: await documentFacts(),
    packaged: {
      currentDir: 'dist/desktop',
      unPackagedUiCss: await size('dist/desktop/ui.css'),
      packageScript: 'npm run package:windows:dir',
    },
  };
}

async function choose(page, id, label) {
  await page.locator(`#${id}`).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
}

async function shoot(page, name) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  summary.screens.push(path.relative(root, file));
}

async function seedWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-acceptance-workspace-'));
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Acceptance workspace\n\nA file to read.\n');
  await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const answer = 42;\n');
  await writeFile(
    path.join(workspace, '.yuantu-note'),
    'The acceptance run only reads this workspace.\n',
  );
  const yuantu = path.join(workspace, '.yuantu');
  await mkdir(yuantu, { recursive: true });
  const store = new SessionStore(path.join(yuantu, 'sessions.sqlite'));
  const session = store.create(workspace);
  for (let index = 0; index < 150; index++) {
    store.append(session.id, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content:
        index % 2 === 0
          ? `历史请求 ${index}：请阅读 src/app.ts。`
          : `历史回答 ${index}：已阅读 src/app.ts，答案是 42。`,
    });
  }
  store.close();
  return { workspace, sessionId: session.id };
}

async function launch(workspace, profile) {
  const env = {
    ...process.env,
    YUANTU_WORKSPACE: workspace,
    YUANTU_NODE_PATH: process.execPath,
    YUANTU_MODEL: 'acceptance-fixture',
    YUANTU_API_KEY: 'acceptance',
    YUANTU_BASE_URL: 'http://127.0.0.1:1',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_SESSION_TITLES: 'false',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.resolve(root, 'dist/desktop/main.cjs'), `--user-data-dir=${profile}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
  const coldStart = Math.round(performance.now() - started);
  const sessionStarted = performance.now();
  if (await page.locator('[data-session-id]').count())
    await page.locator('[data-session-id]').first().click();
  await page.locator('#messages > *').first().waitFor();
  const historyReady = Math.round(performance.now() - sessionStarted);
  return { app, page, coldStart, historyReady };
}

/**
 * The settings page's own entry frames: `PageTransition` animates opacity and offset, so sampling both per frame shows
 * the transition actually ran rather than a final screenshot claiming it did.
 */
function settingsFrames(page) {
  return page.evaluate(async () => {
    const button = document.getElementById('open-settings');
    if (!button) return [];
    const samples = [];
    const start = performance.now();
    button.click();
    return await new Promise((resolve) => {
      const tick = () => {
        const pane = document.querySelector('[data-page-pane][data-page-view="settings-page"]');
        const style = pane ? getComputedStyle(pane) : null;
        samples.push({
          at: Math.round(performance.now() - start),
          opacity: style ? Number(style.opacity) : -1,
          offset: style ? style.transform : 'none',
        });
        if (performance.now() - start > 600) resolve(samples);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
}

async function main() {
  await mkdir(shots, { recursive: true });
  summary.metrics.static = await staticMetrics();

  const { workspace } = await seedWorkspace();
  const timings = [];
  for (let run = 1; run <= 3; run++) {
    const profile = await mkdtemp(path.join(tmpdir(), `yuantu-acceptance-profile-${run}-`));
    const launched = await launch(workspace, profile);
    timings.push({ coldStart: launched.coldStart, historyReady: launched.historyReady });
    const { app, page } = launched;
    if (run === 1) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await shoot(page, 'chat-light-zh');
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      await choose(page, 'ui-appearance', '深色');
      await page.locator('#settings-back').click();
      await page.waitForTimeout(350);
      await shoot(page, 'chat-dark-zh');
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      await choose(page, 'ui-appearance', '跟随系统');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('#settings-back').click();
      await page.waitForTimeout(350);
      await shoot(page, 'chat-system-dark-zh');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      await choose(page, 'ui-appearance', '浅色');
      await choose(page, 'ui-font-size', '小');
      await page.waitForTimeout(250);
      await shoot(page, 'settings-small-zh');
      await choose(page, 'ui-language', 'English');
      await page.waitForTimeout(400);
      await shoot(page, 'settings-small-en');
      await page.locator('#settings-back').click();
      await page.waitForTimeout(350);
      await shoot(page, 'chat-light-en');
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      // Font first: switching back to Chinese renames the field this option is anchored to.
      await choose(page, 'ui-font-size', 'Large');
      await choose(page, 'ui-language', 'Chinese');
      await page.waitForTimeout(400);
      await page.locator('#settings-back').click();
      await page.waitForTimeout(350);
      await shoot(page, 'chat-large-zh');
      await page.setViewportSize({ width: 820, height: 560 });
      await page.waitForTimeout(300);
      await shoot(page, 'chat-min-window-zh');
      await page.setViewportSize({ width: 1280, height: 800 });
      summary.metrics.motion = { settingsEnter: await settingsFrames(page) };
      await page.waitForTimeout(200);
      await page.locator('#settings-back').click();
      await page.waitForTimeout(400);
      await page.locator('#open-workspace').click();
      await page.waitForTimeout(400);
      await shoot(page, 'workspace-open-zh');
    }
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
  await rm(workspace, { recursive: true, force: true });
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  summary.metrics.timings = {
    runs: timings,
    coldStartMedian: median(timings.map((entry) => entry.coldStart)),
    historyReadyMedian: median(timings.map((entry) => entry.historyReady)),
  };
  const hanInUi = await (async () => {
    const dir = path.join(root, 'apps/desktop/ui');
    const files = [];
    const walk = async (at) => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    await walk(dir);
    let han = 0;
    for (const file of files)
      han += (
        withoutComments(await readFile(file, 'utf8')).match(
          /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
        ) ?? []
      ).length;
    return han;
  })();
  summary.metrics.i18n = { ...summary.metrics.static.i18n, hanInUi };
  await writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({ out, screens: summary.screens.length, ...summary.metrics }, null, 2),
  );
}

await main();
