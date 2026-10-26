import path from 'node:path';

/** `STATUS_BREAKPOINT`: Chromium's deliberate crash, reported unsigned by libuv and signed by some shells. */
const BREAKPOINT = 0x80000003;

/**
 * Why Electron exited before opening a window, when the cause is one the launcher can name; otherwise undefined.
 *
 * Windows starts an executable carrying a Low mandatory label at Low integrity, and Chromium cannot start there: it
 * crashes before any application code runs, so the window never appears and nothing is printed. The label arrives by
 * inheritance — a Windows sandbox grant on a workspace that contains this checkout labels the whole tree Low, and one
 * that is never restored leaves `node_modules\electron` with it. `labels` is `icacls` output for the executable.
 */
export function electronCrashDiagnosis(code, executable, labels) {
  if (code === null || code >>> 0 !== BREAKPOINT || !/Low Mandatory Level/i.test(labels))
    return undefined;
  const marker = executable
    .toLowerCase()
    .lastIndexOf(`${path.win32.sep}node_modules${path.win32.sep}`);
  const root = marker >= 0 ? executable.slice(0, marker) : path.win32.dirname(executable);
  return [
    `[desktop] Electron crashed at startup because ${executable} carries a Low integrity label.`,
    '[desktop] Windows runs it at Low integrity, where Chromium cannot start. The label is usually inherited from a',
    '[desktop] Windows sandbox grant on a workspace containing this checkout that was never restored.',
    '[desktop] Restore Medium integrity, then start again:',
    `  icacls "${root}" /setintegritylevel "(OI)(CI)M" /T /C /Q`,
  ].join('\n');
}
