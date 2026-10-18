import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnedCarrier } from '../packages/carrier/index.ts';
import { projectRoot } from './process-fixture.ts';
import { translate, setMainLocale } from '../apps/desktop/i18n.ts';
import { CarrierError, carrierIssue, type CarrierErrorCode } from '../packages/carrier/errors.ts';
import { carrierErrorReply, carrierErrorText } from '../apps/desktop/carrier-errors.ts';
import { redactSecrets } from '../packages/platform/redact.ts';

test('a carrier validation failure preserves a locale-independent code across snapshot serialization', async (t) => {
  const env = { YUANTU_API_KEY: '', YUANTU_MODEL: '', YUANTU_BASE_URL: '' };
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-i18n-'));
  const carrier = spawnedCarrier({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env,
  });
  t.after(async () => {
    await carrier.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await carrier.start();
  await assert.rejects(carrier.dispatch({ type: 'send', prompt: 'Hello' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'modelNotConfigured');
    return true;
  });
  const snapshot = JSON.parse(JSON.stringify(carrier.snapshot));
  assert.deepEqual(snapshot.errorDetail, { code: 'modelNotConfigured', values: {} });
  assert.doesNotMatch(snapshot.error, /\p{Script=Han}/u);
  assert.equal(snapshot.model, '');
  assert.match(translate(`carrier.${snapshot.errorDetail.code}`, 'en-US'), /Model settings/);
  assert.match(translate(`carrier.${snapshot.errorDetail.code}`, 'zh-CN'), /模型设置/);
  await carrier.dispatch({ type: 'create' });
  assert.equal(carrier.snapshot.error, null);
  assert.equal(carrier.snapshot.errorDetail, null);
});

test('policy mismatch copy translates its parameters instead of relying on an exact DOM text match', () => {
  const values = { requested: 'mode=seatbelt, files=read-only', received: 'mode=host' };
  const english = translate('carrier.policyMismatch', 'en-US', values);
  assert.match(english, /mode=seatbelt, files=read-only/);
  assert.match(english, /mode=host/);
  assert.doesNotMatch(english, /\p{Script=Han}|\{requested\}|\{received\}/u);
  assert.match(translate('carrier.policyMismatch', 'zh-CN', values), /策略状态未知/);
});

test('serialized command failures can be rendered in either language without another command', (t) => {
  setMainLocale('en-US');
  t.after(() => setMainLocale('zh-CN'));
  const reply = JSON.parse(JSON.stringify(carrierErrorReply(new CarrierError('hostRecovering'))));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /restarting automatically/);
  assert.doesNotMatch(carrierErrorText(reply, 'en-US'), /\p{Script=Han}/u);
  assert.match(carrierErrorText(reply, 'zh-CN'), /自动重启/);
  assert.match(carrierErrorText(reply, 'en-US'), /restarting automatically/);
});

test('all carrier-owned failures have Chinese and English copy in the desktop dictionary', () => {
  const codes: CarrierErrorCode[] = [
    'hostExited',
    'hostDisconnected',
    'policyUnsupported',
    'policyMismatch',
    'hostRecoveryFailed',
    'hostRecovering',
    'hostNotReady',
    'policyUnconfirmed',
    'modelNotConfigured',
    'draftPlanningFailed',
    'sessionRequired',
    'subagentNotInSession',
    'sessionOperationBusy',
    'runBusy',
    'operationBusy',
    'taskNotFound',
    'shellCommand',
  ];
  for (const code of codes) {
    const values = { requested: 'mode=seatbelt', received: 'mode=host', message: 'Remote failure' };
    const reply = { error: 'fallback', errorDetail: { code, values } };
    const english = carrierErrorText(reply, 'en-US');
    assert.notEqual(english, 'fallback', code);
    assert.doesNotMatch(english, /\p{Script=Han}|\{\w+\}/u, code);
    assert.match(carrierErrorText(reply, 'zh-CN'), /\p{Script=Han}/u, code);
  }
});

test('diagnostic parameters are redacted before serialization and raw external failures keep their text', () => {
  const env = { YUANTU_API_KEY: 'fixture-local-secret' };
  const detail = carrierIssue(
    new CarrierError('draftPlanningFailed', {
      message: 'Rejected fixture-local-secret',
      attempts: 2,
    }),
    (value) => redactSecrets(value, env),
  );
  assert.doesNotMatch(JSON.stringify(detail), /fixture-local-secret/);
  assert.equal(detail?.values.attempts, 2);
  assert.match(
    carrierErrorText({ error: 'fallback', errorDetail: detail }, 'en-US'),
    /\[redacted\]/,
  );
  const reply = carrierErrorReply(new Error('Upstream rejected the request'));
  assert.equal(reply.errorDetail, undefined);
  assert.equal(carrierErrorText(reply, 'zh-CN'), 'Upstream rejected the request');
  assert.equal(carrierErrorText({ error: 'Older Host failure' }, 'en-US'), 'Older Host failure');
});
