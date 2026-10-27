import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

if (process.platform !== 'win32') throw new Error('Windows package smoke requires Windows');
const directory = path.resolve(process.argv[2] || 'dist/release/win-unpacked');
const root = await mkdtemp(path.resolve('.scratch/windows-package-smoke-'));
const profile = path.join(root, 'profile');
const other = path.join(root, '另一个 工作区');
await mkdir(other);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^(?:YUANTU_|CODEX_|NODE_)/.test(key) ||
    /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)_API_KEY$/.test(key)
  )
    delete env[key];
}
delete env.ELECTRON_RUN_AS_NODE;
env.YUANTU_SESSION_TITLES = 'false';
let application;
let hostPids = [];
const log = [];
async function snapshot(page) {
  const reply = await page.evaluate(() => window.yuantu.invoke({ type: 'snapshot' }));
  assert.equal(reply.ok, true, reply.error);
  return reply.state;
}
async function launch(args = []) {
  application = await electron.launch({
    executablePath: path.join(directory, 'YuanTu Agent.exe'),
    args: [`--user-data-dir=${profile}`, ...args],
    env,
    timeout: 20000,
  });
  application.on('console', (message) => log.push(message.text()));
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.yuantu);
  // waitForFunction's predicate is synchronous; poll each completed IPC reply rather than returning a Promise.
  const deadline = Date.now() + 20000;
  for (;;) {
    const state = await snapshot(page);
    if (state.ready && state.hostPid && state.session.sessionId) {
      hostPids.push(state.hostPid);
      break;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Packaged Host not ready: ${JSON.stringify({ stage: state.startupStage, error: state.error })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const security = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  }));
  assert.equal(security.packaged, true);
  assert.equal(security.noSandbox, false);
  assert.equal(security.preferences.sandbox, true);
  assert.equal(security.preferences.contextIsolation, true);
  assert.equal(security.preferences.nodeIntegration, false);
  return page;
}
async function close() {
  const app = application;
  if (!app) return;
  application = undefined;
  let timer;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          app.process().kill();
          reject(new Error('Packaged desktop did not exit'));
        }, 20000);
      }),
    ]);
    for (const pid of hostPids) {
      assert.throws(
        () => process.kill(pid, 0),
        { code: 'ESRCH' },
        'Host must exit with its application',
      );
    }
    hostPids = [];
  } finally {
    clearTimeout(timer);
  }
}
try {
  let page = await launch();
  const first = await snapshot(page);
  assert.equal(
    first.workspace.toLowerCase(),
    (await realpath(path.join(profile, 'workspace'))).toLowerCase(),
  );
  assert.equal(await page.locator('.project-row').count(), 1);
  const denied = await page.evaluate(
    (folder) => window.yuantu.projects({ type: 'add', path: folder }),
    directory,
  );
  assert.equal(denied.ok, false, 'application directory cannot be registered as a workspace');
  const renamed = await page.evaluate(
    (id) => window.yuantu.invoke({ type: 'rename', id, title: 'Packaged retained session' }),
    first.session.sessionId,
  );
  assert.equal(renamed.ok, true, renamed.error);
  await page.screenshot({ path: path.join(root, 'packaged.png') });
  await close();
  page = await launch();
  await page.getByText('Packaged retained session', { exact: true }).first().waitFor();
  await close();
  page = await launch([`--workspace=${other}`]);
  assert.equal(
    (await snapshot(page)).workspace.toLowerCase(),
    (await realpath(other)).toLowerCase(),
  );
  await close();
  page = await launch();
  assert.equal(
    (await snapshot(page)).workspace.toLowerCase(),
    (await realpath(other)).toLowerCase(),
  );
  const registry = await page.evaluate(() => window.yuantu.projects({ type: 'list' }));
  assert.equal(registry.registry.workspaces.length, 2);
  await close();
  const result = {
    ok: true,
    root,
    launches: 4,
    sandbox: true,
    workspaceRestore: true,
    retainedSession: true,
    applicationDirectoryRejected: true,
    hostsExited: true,
  };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(path.join(root, 'failure.log'), `${error.stack}\n${log.join('\n')}`);
  throw error;
} finally {
  await close();
}
