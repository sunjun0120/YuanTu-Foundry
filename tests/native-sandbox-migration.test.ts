import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandboxConfig, setSandboxMode } from '../packages/tools/sandbox-provider.ts';
import {
  defaultSandboxMode,
  parseSandboxSettingsCommand,
} from '../apps/desktop/sandbox-settings.ts';
import { permissionPreset } from '../apps/desktop/permission-presets.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';
import { applySandboxDefaults, executionEnvironment } from '../apps/shared/runtime.ts';

test('desktop and guarded presets use native isolation without a container runtime', () => {
  assert.equal(defaultSandboxMode({}), 'native');
  assert.equal(permissionPreset('guarded').sandbox, 'native');
  assert.equal(permissionPreset('observe').sandbox, 'native');
});

test('shipped app launch defaults migrate the legacy Windows backend to native', () => {
  const env = { YUANTU_SANDBOX: 'windows', YUANTU_SANDBOX_HOOK: 'windows' };
  applySandboxDefaults(env);
  assert.equal(env.YUANTU_SANDBOX, 'native');
  assert.equal(env.YUANTU_SANDBOX_HOOK, 'native');
  assert.equal(defaultSandboxMode({ YUANTU_SANDBOX: 'windows' }), 'native');
  assert.equal(parseSandboxSettingsCommand({ type: 'set', mode: 'windows' }).mode, 'native');
});

test('Windows native command guidance describes account isolation and child processes', () => {
  if (process.platform !== 'win32') return;
  const previous = process.env.YUANTU_SANDBOX;
  try {
    process.env.YUANTU_SANDBOX = 'native';
    assert.match(executionEnvironment(), /sandbox account/i);
    assert.doesNotMatch(executionEnvironment(), /spawn EPERM|reads and network are unconfined/);
  } finally {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
  }
});

test('removed container configuration fails with an explicit migration message', () => {
  for (const mode of ['docker', 'sbx']) {
    assert.throws(() => resolveSandboxConfig({ YUANTU_SANDBOX: mode }), /removed.*native/i);
    assert.throws(() => setSandboxMode(mode as never), /removed.*native/i);
    assert.throws(() => defaultSandboxMode({ YUANTU_SANDBOX: mode }), /removed.*native/i);
    assert.throws(() => parseSandboxSettingsCommand({ type: 'set', mode }), /removed.*native/i);
    assert.throws(() => parseCarrierCommand({ type: 'sandbox', mode }), /removed.*native/i);
  }
});

test('native configuration preserves file and network policy independently', () => {
  const config = resolveSandboxConfig({
    YUANTU_SANDBOX: 'native',
    YUANTU_SANDBOX_FILES: 'read-only',
    YUANTU_SANDBOX_NETWORK: 'denied',
  });
  assert.equal(config.mode, 'native');
  assert.equal(config.files, 'read-only');
  assert.equal(config.network, 'denied');
  assert.throws(
    () => resolveSandboxConfig({ YUANTU_SANDBOX_NETWORK: 'pretend-offline' }),
    /network/i,
  );
  assert.throws(() => resolveSandboxConfig({ YUANTU_SANDBOX_FILES: 'arbitrary' }), /file/i);
});
