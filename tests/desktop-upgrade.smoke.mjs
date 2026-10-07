import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

test(
  'the installed desktop upgrades through its native confirmation and confirms the new Host before retaining its session and encrypted settings',
  { skip: !process.env.UPGRADE_TEST_INSTALLER, timeout: 300000 },
  async (t) => {
    const root = path.resolve('.scratch/p1', `upgrade-${randomUUID()}`);
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
    const launch = () =>
      electron.launch({
        executablePath: path.join(installed, 'YuanTu Agent.exe'),
        args: [`--user-data-dir=${profile}`],
        cwd: installed,
        env,
      });
    let app = await launch();
    let newPid;
    t.after(async () => {
      await app?.close().catch(() => {});
      if (newPid) {
        try {
          process.kill(newPid, 0);
          await closeWindow(newPid);
        } catch {}
      }
      await promisify(execFile)('powershell.exe', [
        '-NoProfile',
        '-File',
        path.resolve('scripts/verify-windows-install.ps1'),
        '-Installer',
        'unused',
        '-InstallDirectory',
        installed,
        '-Uninstall',
      ]).catch(() => {});
      // Keep this isolated evidence directory and snapshots for inspection; do not prune rollback evidence.
    });
    let page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
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
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    const settings = await readFile(path.join(profile, 'model-settings.json'));
    await app.evaluate(({ dialog, Menu }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showErrorBox = (title, message) =>
        console.error(`UPGRADE_TEST_ERROR ${title}: ${message}`);
      Menu.getApplicationMenu().items[0].submenu.items[0].click();
    }, process.env.UPGRADE_TEST_INSTALLER);
    const directoryRoot = path.join(profile, 'upgrades');
    let journalFile;
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
    assert.equal(journal?.phase, 'completed', JSON.stringify(journal));
    assert.equal(journal.confirmedVersion, journal.manifest.version);
    newPid = Number(await readFile(`${journalFile}.pid`, 'utf8'));
    await closeWindow(newPid);
    newPid = undefined;
    app = undefined;
    assert.deepEqual(await readFile(path.join(profile, 'model-settings.json')), settings);
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.getByText('UPGRADE_PRESERVED_REPLY', { exact: true }).waitFor();
    const retained = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(retained.settings.hasKey, true);
    const application = await app.evaluate(({ app }) => app.getVersion());
    assert.equal(application, journal.manifest.version);
    console.log(`Upgrade verified; evidence: ${journalFile}`);
  },
);

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
