import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';
import { electronCrashDiagnosis } from './desktop-launch-diagnosis.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index],
    value = args[index + 1];
  if (
    !['--workspace', '--user-data-dir'].includes(key) ||
    !value ||
    value.startsWith('--') ||
    options[key]
  ) {
    console.error(
      'Usage: npm run desktop -- [--workspace <directory>] [--user-data-dir <directory>]',
    );
    process.exit(1);
  }
  options[key] = path.resolve(value);
}
const env = {
  ...process.env,
  YUANTU_NODE_PATH: process.execPath,
  YUANTU_WORKSPACE: path.resolve(
    options['--workspace'] || process.env.YUANTU_WORKSPACE || process.cwd(),
  ),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
console.log(`[desktop] Opening YuanTu Agent: ${env.YUANTU_WORKSPACE}`);
const child = spawn(
  electronPath,
  [
    path.join(project, 'dist/desktop/main.cjs'),
    ...(options['--user-data-dir'] ? [`--user-data-dir=${options['--user-data-dir']}`] : []),
  ],
  {
    cwd: project,
    env,
    stdio: 'inherit',
    shell: false,
    // This is the user-facing GUI. On Windows, SW_HIDE also hides its first window.
    windowsHide: false,
  },
);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.exitCode = code ?? 1;
  if (process.platform !== 'win32' || code === 0) return;
  // A crash before the first window prints nothing of its own; name the cause when it is the integrity label.
  const labels = spawnSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [electronPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  ).stdout;
  const diagnosis = electronCrashDiagnosis(code, electronPath, labels ?? '');
  if (diagnosis) console.error(diagnosis);
});
