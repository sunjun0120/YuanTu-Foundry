// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

// Wait for a usable composer; when it never comes, print what the desktop says it is doing before failing.
async function waitForPrompt(page, label) {
  try {
    await page.waitForFunction(() => document.querySelector('#prompt')?.disabled === false);
  } catch (error) {
    const state = await page
      .evaluate(async () => {
        const snapshot = await window.yuantu.invoke({ type: 'snapshot' });
        const { startupStage, ready, configured, host, hostPid, recovery, error, errorDetail } =
          snapshot.state ?? {};
        return {
          ok: snapshot.ok,
          error: snapshot.error,
          state: { startupStage, ready, configured, host, hostPid, recovery, error, errorDetail },
          text: document.body.innerText.slice(0, 2000),
        };
      })
      .catch((reason) => String(reason));
    console.error(`${label} snapshot:`, JSON.stringify(state));
    throw error;
  }
}

test(
  'the installed desktop upgrades through its native confirmation and confirms the new Host before retaining its session and encrypted settings',
  {
    skip:
      !process.env.UPGRADE_TEST_INSTALLER && 'needs UPGRADE_TEST_INSTALLER from an upgrade fixture',
    timeout: 300000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-upgrade-'));
    const installed = path.join(root, '中文 升级目录'),
      profile = path.join(root, '用户 profile'),
      workspace = path.join(root, '用户 workspace');
    await mkdir(workspace, { recursive: true });
    await cp(
      process.env.UPGRADE_TEST_OLD_DIRECTORY || '.scratch/p1/dev03-old-application',
      installed,
      { recursive: true },
    );
    // NSIS maintains one application registration. Refuse to run this test over a real installation.
    await promisify(execFile)('powershell.exe', [
      '-NoProfile',
      '-Command',
      `. '${path.resolve('scripts/windows-install-safety.ps1').replaceAll("'", "''")}'; Assert-YuanTuInstallations @(Get-YuanTuInstallations) '${installed.replaceAll("'", "''")}'`,
    ]);
    const url = await httpFixture(t, (_body, response) =>
      sendFrames(response, frames('UPGRADE_PRESERVED_REPLY')),
    );
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: workspace,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    // The desktop's stderr carries the UPGRADE_TEST_ERROR dialogs below; without it a failed upgrade is silent.
    const launch = async () => {
      const launched = await electron.launch({
        executablePath: path.join(installed, 'YuanTu Agent.exe'),
        args: [`--user-data-dir=${profile}`],
        cwd: installed,
        env,
      });
      launched.process().stderr?.on('data', (chunk) => process.stderr.write(`[desktop] ${chunk}`));
      return launched;
    };
    let app = await launch();
    let newPid;
    let journalFile;
    t.after(async () => {
      // Every step here is bounded: a desktop or uninstaller that never returns would keep the runner up long
      // after the test failed, and the job would end on its step timeout with the failure buried.
      let timer;
      await Promise.race([
        app?.close().catch(() => {}),
        new Promise((resolve) => (timer = setTimeout(resolve, 30_000))),
      ]);
      clearTimeout(timer);
      // The upgraded desktop the worker launched holds the install directory open; the uninstaller waits on it.
      newPid ??= await readFile(`${journalFile}.pid`, 'utf8')
        .then((text) => JSON.parse(text).pid)
        .catch(() => undefined);
      if (newPid) {
        try {
          process.kill(newPid, 0);
          await closeWindow(newPid);
        } catch {
          await promisify(execFile)('taskkill', ['/PID', String(newPid), '/T', '/F']).catch(
            () => {},
          );
        }
      }
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-File',
          path.resolve('scripts/verify-windows-install.ps1'),
          '-Installer',
          'unused',
          '-InstallDirectory',
          installed,
          '-Uninstall',
        ],
        { timeout: 120_000 },
      ).catch(() => {});
      // Keep this isolated evidence directory and snapshots for inspection; do not prune rollback evidence.
    });
    let page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForPrompt(page, 'Old desktop startup');
    const saved = await page.evaluate(
      (url) =>
        window.yuantu.settings({
          type: 'save',
          values: {
            name: 'Upgrade retention',
            baseUrl: url,
            model: 'fixture',
            protocol: 'anthropic',
            apiKey: 'encrypted-upgrade-fixture',
            maxContextTokens: 128000,
          },
        }),
      url,
    );
    assert.equal(saved.ok, true, saved.error);
    await page.locator('#prompt').fill('Create an upgrade retention witness');
    await page.locator('#send').click();
    await page.getByText('UPGRADE_PRESERVED_REPLY', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    const settings = await readFile(path.join(profile, 'model-settings.json'));
    await app.evaluate(({ dialog, Menu }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showErrorBox = (title, message) =>
        console.error(`UPGRADE_TEST_ERROR ${title}: ${message}`);
      Menu.getApplicationMenu().items[0].submenu.items[0].click();
    }, process.env.UPGRADE_TEST_INSTALLER);
    const directoryRoot = path.join(profile, 'upgrades');
    let journal;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      try {
        const directories = await readdir(directoryRoot);
        journalFile = path.join(directoryRoot, directories[0], 'upgrade.json');
        journal = JSON.parse(await readFile(journalFile, 'utf8'));
        if (journal.phase === 'completed' || journal.phase.endsWith('failed')) break;
      } catch {}
      await delay(200);
    }
    if (journal?.phase !== 'completed') await reportUpgrade(directoryRoot);
    assert.equal(journal?.phase, 'completed', `Upgrade journal: ${JSON.stringify(journal)}`);
    assert.equal(journal.confirmedVersion, journal.manifest.version);
    newPid = JSON.parse(await readFile(`${journalFile}.pid`, 'utf8')).pid;
    await closeWindow(newPid);
    newPid = undefined;
    app = undefined;
    assert.deepEqual(await readFile(path.join(profile, 'model-settings.json')), settings);
    app = await launch();
    page = await app.firstWindow();
    await waitForPrompt(page, 'Upgraded desktop startup');
    await page.getByText('UPGRADE_PRESERVED_REPLY', { exact: true }).waitFor();
    const retained = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(retained.settings.hasKey, true);
    const application = await app.evaluate(({ app }) => app.getVersion());
    assert.equal(application, journal.manifest.version);
    console.log(`Upgrade verified; evidence: ${journalFile}`);
  },
);

/** Print every small file the upgrade left in its directories (journal, markers, worker log). */
async function reportUpgrade(directoryRoot) {
  let directories = [];
  try {
    directories = await readdir(directoryRoot);
  } catch (error) {
    console.error(`No upgrade directory at ${directoryRoot}: ${error.code}`);
  }
  for (const directory of directories) {
    for (const name of await readdir(path.join(directoryRoot, directory))) {
      const file = path.join(directoryRoot, directory, name);
      if (!/\.(json|log|ready|pid)$/.test(name)) {
        console.error(`[upgrade] ${directory}/${name}`);
        continue;
      }
      const text = await readFile(file, 'utf8').catch((error) => `<${error.code}>`);
      console.error(`[upgrade] ${directory}/${name}:\n${text.slice(-4000)}`);
    }
  }
}

async function closeWindow(pid) {
  await promisify(execFile)('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class UpgradeWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }'; $p=Get-Process -Id ${pid} -ErrorAction Stop; if ($p.ProcessName -ne 'YuanTu Agent') { throw 'Unexpected test process' }; if (-not [UpgradeWindow]::PostMessage($p.MainWindowHandle,16,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Could not close test window' }`,
  ]);
  for (let n = 0; n < 100; n++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(100);
  }
  throw new Error('Upgraded desktop did not close');
}
