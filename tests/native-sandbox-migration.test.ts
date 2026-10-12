import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandboxConfig, setSandboxMode } from '../packages/tools/sandbox-provider.ts';
import {
  defaultSandboxMode,
  parseSandboxSettingsCommand,
} from '../apps/desktop/sandbox-settings.ts';
import { permissionPreset } from '../apps/desktop/permission-presets.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';

test('desktop and guarded presets use native isolation without a container runtime', () => {
  assert.equal(defaultSandboxMode({}), 'native');
  assert.equal(permissionPreset('guarded').sandbox, 'native');
  assert.equal(permissionPreset('observe').sandbox, 'native');
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
