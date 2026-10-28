import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { refreshAccountReadiness } from '../packages/sandbox/sandbox-account.ts';
import { stopBrokers } from '../packages/sandbox/sandbox-account-broker.ts';
import { accountAcceptanceSkip } from '../scripts/windows-account-ci.mjs';

export const windowsAccountTests = { skip: accountAcceptanceSkip(), timeout: 120_000 };
export const nativeAccountTests = {
  skip: process.platform === 'darwin' ? false : accountAcceptanceSkip(),
  timeout: 120_000,
};

/** Tests never provision accounts. An enabled CI run fails if workflow setup did not make them usable. */
export function useAccountTests(): void {
  before(async () => {
    if (windowsAccountTests.skip) return;
    const status = await refreshAccountReadiness();
    assert.equal(status?.ready, true, JSON.stringify(status));
  });
  after(async () => {
    if (!windowsAccountTests.skip) await stopBrokers();
  });
}
