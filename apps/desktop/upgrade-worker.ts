import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  checkUpgrade,
  stageUpgrade,
  prepareUpgrade,
  runUpgrade,
  rollbackUpgrade,
  type UpgradeJournal,
  type StagedUpgrade,
  type DesktopRelease,
} from '../../packages/maintenance/desktop-upgrade.ts';

async function child(
  executable: string,
  args: string[],
  options: { cwd?: string; detached?: boolean } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { ...options, windowsHide: true, stdio: 'ignore' });
    process.once('error', reject);
    if (options.detached)
      process.once('spawn', () => {
        process.unref();
        resolve(process.pid!);
      });
    else process.once('exit', (code) => resolve(code ?? -1));
  });
}
const [operation, argument, ...values] = process.argv.slice(2);
async function main() {
  if (!argument) throw new Error('Upgrade maintenance requires explicit arguments');
  if (operation === 'check')
    return checkUpgrade(argument, JSON.parse(values[0]!) as DesktopRelease);
  if (operation === 'stage')
    return stageUpgrade(
      argument,
      values[0]!,
      JSON.parse(values[1]!) as DesktopRelease,
      values[2] ? JSON.parse(values[2]) : undefined,
    );
  if (operation === 'prepare')
    return prepareUpgrade(
      JSON.parse(readFileSync(argument, 'utf8')) as StagedUpgrade,
      values[0]!,
      values[1]!,
      JSON.parse(values[2]!) as DesktopRelease,
      values[3],
    );
  if (operation === 'rollback') {
    if (values[0] !== '--offline')
      throw new Error('Close the application and every Host/CLI; then explicitly pass --offline');
    const journal = rollbackUpgrade(argument);
    if (!values.includes('--no-launch'))
      await child(
        path.join(journal.softwareBackup, 'YuanTu Agent.exe'),
        [`--user-data-dir=${journal.profile}`, `--workspace=${journal.workspace}`],
        { cwd: journal.softwareBackup, detached: true },
      );
    return { phase: journal.phase, software: journal.softwareBackup };
  }
  if (operation !== 'install') throw new Error('Unknown upgrade operation');
  const journal = JSON.parse(readFileSync(argument, 'utf8')) as UpgradeJournal;
  const parentPid = Number(values[0]);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0)
    throw new Error('Installer requires the original desktop PID');
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error('Original desktop has not exited; refusing installation');
    await delay(100);
  }
  await runUpgrade(journal, {
    install: (j) => child(j.installer, ['/S', `/D=${j.installDirectory}`]),
    launch: async (j) => {
      const pid = await child(
        path.join(j.installDirectory, 'YuanTu Agent.exe'),
        [
          `--user-data-dir=${j.profile}`,
          `--workspace=${j.workspace}`,
          `--upgrade-journal=${j.journal}`,
        ],
        { cwd: j.installDirectory, detached: true },
      );
      writeFileSync(`${j.journal}.pid`, String(pid), { flag: 'wx' });
    },
    ready: async (j) => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (existsSync(`${j.journal}.ready`)) {
          const ready = JSON.parse(readFileSync(`${j.journal}.ready`, 'utf8')) as {
            version: string;
          };
          return ready.version === j.manifest.version;
        }
        await delay(200);
      }
      return false;
    },
  });
  return JSON.parse(readFileSync(argument, 'utf8')) as UpgradeJournal;
}
main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
