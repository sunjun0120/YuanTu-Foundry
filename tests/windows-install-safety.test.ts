import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test(
  'installer verification rejects unknown or outside NSIS locations and accepts only its own directory',
  { skip: process.platform !== 'win32' },
  () => {
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
