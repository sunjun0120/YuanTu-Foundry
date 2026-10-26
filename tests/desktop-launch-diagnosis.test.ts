import test from 'node:test';
import assert from 'node:assert/strict';
import { electronCrashDiagnosis } from '../scripts/desktop-launch-diagnosis.mjs';

/**
 * Electron started from a Low integrity executable dies before any application code runs: no window, no output, an
 * exit code nobody can read. The launcher is the only place left that can say why.
 */
const electron = 'E:\\repo\\node_modules\\electron\\dist\\electron.exe';
const lowLabel = `${electron} BUILTIN\\Users:(I)(RX)\n    Mandatory Label\\Low Mandatory Level:(I)(NW)\n`;

test('a breakpoint exit from a Low integrity Electron names the label and the repair', () => {
  for (const code of [0x80000003, -2147483645]) {
    const message = electronCrashDiagnosis(code, electron, lowLabel);
    assert.ok(message, `exit ${code}`);
    assert.match(message, /Low integrity/);
    assert.ok(message.includes(`icacls "E:\\repo" /setintegritylevel "(OI)(CI)M" /T /C /Q`));
  }
});

test('ordinary exits and crashes without a Low label are left alone', () => {
  assert.equal(electronCrashDiagnosis(0, electron, lowLabel), undefined);
  assert.equal(electronCrashDiagnosis(1, electron, lowLabel), undefined);
  const medium = lowLabel.replace('Low Mandatory Level', 'Medium Mandatory Level');
  assert.equal(electronCrashDiagnosis(0x80000003, electron, medium), undefined);
  assert.equal(electronCrashDiagnosis(0x80000003, electron, ''), undefined);
});
