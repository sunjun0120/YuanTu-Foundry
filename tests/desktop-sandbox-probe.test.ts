import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SandboxEnvironment } from '../apps/desktop/sandbox-environment.ts';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import * as sandboxSetup from '../apps/desktop/sandbox-setup.ts';
import { withinQuitDeadline } from '../apps/desktop/quit-deadline.ts';
import { tempRoot } from './temp-fixture.ts';

test('manual upgrade rejects a busy background Host before offering an installer', async () => {
  const source = await readFile(
    new URL('../apps/desktop/main-upgrade.ts', import.meta.url),
    'utf8',
  );
  const code = source
    .slice(source.indexOf('export async function manualUpgrade'))
    .replace('export async function', 'async function');
  const errors: string[] = [];
  let offered = false;
  const current = { busy: false, snapshot: { ready: true } };
  await runInNewContext(stripTypeScriptTypes(`${code}\nmanualUpgrade(ctx);`), {
    ctx: {
      window: {},
      service: current,
      services: [current, { busy: false, snapshot: { ready: true, session: { otherRuns: [{}] } } }],
      switching: false,
      quitting: false,
      renewSettingsAbort() {},
    },
    app: { isPackaged: true },
    process: { platform: 'win32' },
    desktopRelease: async () => ({ version: '0.1.0' }),
    dialog: {
      showOpenDialog: async () => {
        offered = true;
        return { canceled: true };
      },
      showErrorBox: (_title: string, message: string) => errors.push(message),
    },
    mainText: (key: string) => key,
    safeError: (error: Error) => error.message,
  });
  assert.match(errors.join('\n'), /upgrade.busy/);
  assert.equal(offered, false);
});

test('desktop quit bounds sandbox initialization and still closes both carriers', async () => {
  const source = await readFile(new URL('../apps/desktop/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.on('before-quit',");
  const end = source.indexOf("app.on('window-all-closed'", start);
  let beforeQuit!: (event: { preventDefault(): void }) => void;
  let quit!: () => void;
  const exited = new Promise<boolean>((resolve) => {
    quit = () => resolve(true);
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = 0;
  const errors: string[] = [];
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    app: {
      on: (_event: string, callback: typeof beforeQuit) => {
        beforeQuit = callback;
      },
      quit,
    },
    quitting: false,
    quitAllowed: false,
    browserViews: null,
    workspaceHosts: null,
    profileWrites: new Set(),
    settingsAbort: new AbortController(),
    sandboxInitializing: pending,
    waitForSandboxInitialization: (setup: Promise<unknown>) =>
      (
        sandboxSetup as unknown as {
          waitForSandboxInitialization?: (setup: Promise<unknown>, ms: number) => Promise<boolean>;
        }
      ).waitForSandboxInitialization?.(setup, 20),
    // The handler bounds each step with this; the real one is used so the bound is exercised, not stubbed away.
    withinQuitDeadline,
    service: {
      stop: async () => {
        closed++;
      },
    },
    openingService: {
      stop: async () => {
        closed++;
      },
    },
    dialog: {
      showErrorBox: (_title: string, detail: string) => {
        errors.push(detail);
      },
    },
    mainText: (key: string) => key,
    safeError: String,
  });
  beforeQuit({ preventDefault() {} });
  let guard: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => {
      guard = setTimeout(() => resolve(false), 250);
    }),
  ]);
  clearTimeout(guard);
  release();
  assert.equal(completed, true, 'stalled initialization must not block app quit forever');
  assert.equal(closed, 2, 'initialization timeout must not skip owned carrier cleanup');
  assert.match(errors.join('\n'), /unconfirmed/i);
});

test('desktop probes use its standalone Node with a sanitized environment', async (t) => {
  const root = await tempRoot(t, 'yuantu-desktop-probe-');
  const workerPath = path.join(root, 'probe.mjs');
  await writeFile(
    workerPath,
    `process.stdout.write(JSON.stringify({ availability: process.argv[2] === 'seatbelt' && !process.versions.electron && !process.env.YUANTU_API_KEY ? null : 'wrong probe runtime or environment' }));`,
  );
  const environment = new SandboxEnvironment(
    { YUANTU_API_KEY: 'fixture-only' },
    { nodePath: process.execPath, workerPath },
  );
  assert.equal(await environment.probe('seatbelt'), null);
  assert.equal(environment.known('seatbelt'), true);
  assert.equal(environment.defaultMode, 'native');
});

test('desktop probes report malformed worker output and never change the selected mode', async (t) => {
  const root = await tempRoot(t, 'yuantu-desktop-probe-bad-');
  const workerPath = path.join(root, 'probe.mjs');
  await writeFile(workerPath, `process.stdout.write('not a protocol reply');`);
  const environment = new SandboxEnvironment({}, { nodePath: process.execPath, workerPath });
  assert.match((await environment.probe('host')) ?? '', /probe failed/i);
  assert.equal(environment.defaultMode, 'native');
});
