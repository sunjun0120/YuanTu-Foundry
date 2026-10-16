import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * `scripts/windows-install-safety.ps1` is dot-sourced, so this test needs a machine willing to load the file.
 * A checkout whose integrity label makes Windows refuse it cannot verify anything about installer logic, and
 * the refusal must not be read as the helper's own "outside the install directory" rejection — those are
 * different facts about different things.
 *
 * The signature is the one `packages/office/automation.ts` classifies for the same reason; it is repeated here
 * rather than imported so that a test about installer logic does not depend on the office package to describe
 * an environment fact.
 */
const SCRIPT_REFUSAL = /AuthorizationManager|UnauthorizedAccess|PSSecurityException/i;

test(
  'installer verification rejects unknown or outside NSIS locations and accepts only its own directory',
  { skip: process.platform !== 'win32' },
  (t) => {
    const helper = path.resolve('scripts/windows-install-safety.ps1').replaceAll("'", "''");
    const target = 'C:\\project\\.scratch\\test install';
    const run = (entry: string) =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; . '${helper}'; Assert-YuanTuInstallations @(${entry}) '${target}'`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
    const outside = run(
      `[pscustomobject]@{ DisplayName='YuanTu Agent'; UninstallString='"C:\\real install\\Uninstall YuanTu Agent.exe" /currentuser' }`,
    );
    if (SCRIPT_REFUSAL.test(outside.stderr)) {
      t.skip(
        `Windows refused to load the install-safety helper: ${outside.stderr.trim().split('\n')[0]}`,
      );
      return;
    }
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /outside.*verification|refusing to replace/i);
    const unknown = run("[pscustomobject]@{ DisplayName='YuanTu Agent' }");
    assert.notEqual(unknown.status, 0);
    const own = run(
      `[pscustomobject]@{ DisplayName='YuanTu Agent 0.1.0'; UninstallString='"${target}\\Uninstall YuanTu Agent.exe" /currentuser' }`,
    );
    assert.equal(own.status, 0, own.stderr);
  },
);
