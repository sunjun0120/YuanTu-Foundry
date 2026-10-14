import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileTools } from '../packages/tools/files.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import {
  executionPolicy,
  requireExecutionCapabilities,
  withExecutionPolicy,
  currentExecutionPolicy,
} from '../packages/tools/execution-policy.ts';
import {
  registerExecutionCapabilities,
  seatbeltCapabilities,
} from '../packages/tools/execution-capabilities.ts';
import type { ExecutionPolicy, FileEffect } from '../packages/protocol/execution.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-file-policy-'));
  const tools = new ToolRegistry();
  for (const tool of fileTools(root)) tools.register(tool);
  t.after(async () => {
    await tools.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('yuantu-file-policy-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, tools };
}

test('explicit read-only file policy prevents a real file write before approval in every backend', async (t) => {
  const { root, tools } = await fixture(t);
  let approvals = 0;
  for (const mode of ['host', 'windows', 'seatbelt', 'native'] as const) {
    const file = `${mode}.txt`;
    const result = await tools.execute(
      { id: mode, name: 'write_file', arguments: { path: file, content: 'fixture' } },
      {
        signal: new AbortController().signal,
        executionPolicy: executionPolicy(mode, { files: 'read-only' }),
        approve: async () => {
          approvals++;
          return true;
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /read.only/i);
    await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
  }
  assert.equal(approvals, 0);
});

test('container command restrictions leave approved workspace file edits available and denied edits have no effect', async (t) => {
  const { root, tools } = await fixture(t);
  let approvals = 0;
  for (const mode of ['seatbelt', 'native'] as const) {
    for (const allowed of [false, true]) {
      const file = `${mode}-${allowed}.txt`;
      const result = await tools.execute(
        { id: file, name: 'write_file', arguments: { path: file, content: 'fixture' } },
        {
          signal: new AbortController().signal,
          executionPolicy: executionPolicy(mode),
          approve: async () => {
            approvals++;
            return allowed;
          },
        },
      );
      assert.equal(result.isError, !allowed, result.content);
      if (allowed) assert.equal(await readFile(path.join(root, file), 'utf8'), 'fixture');
      else await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
    }
  }
  assert.equal(approvals, 4);
});

test('the policy factory refuses values a backend would otherwise reinterpret', () => {
  // `host` and `windows` declare fixed capabilities and never read `files`, so without this check an unknown
  // value would travel into the policy the tools then run under. For the backends that do read it the
  // declaration check would reject it, but with a different message — the refusal has to be this one.
  for (const mode of ['host', 'windows', 'seatbelt', 'native'] as const)
    for (const files of ['bogus', 'read-write'] as unknown as FileEffect[])
      assert.throws(() => executionPolicy(mode, { files }), /invalid file policy/i);
  // The image arrives from configuration and is interpolated into what the sandbox runtime is asked to run,
  // so this regex is the only barrier in front of it.
  for (const image of ['bad image!', '', '-leading-dash', 'x'.repeat(257)])
    assert.throws(() => executionPolicy('seatbelt', { image }), /invalid sandbox image/i);
});

test('a backend that cannot enforce the requested network policy refuses rather than widening it', () => {
  // `host` and `windows` report `unrestricted`, so a caller asking them for a denied network must be refused.
  // Returning a policy instead would hand back a weaker confinement than the one that was asked for, and the
  // caller would have no way to tell: the policy object itself would claim the network is open.
  for (const mode of ['host', 'windows'] as const)
    assert.throws(
      () => executionPolicy(mode, { network: 'denied' }),
      /network capability does not satisfy/i,
    );
  // A backend that can enforce it returns exactly what was asked for, and records the request.
  const denied = executionPolicy('seatbelt', { network: 'denied' });
  assert.equal(denied.network, 'denied');
  assert.equal(denied.requestedNetwork, 'denied');
});

test('a policy handed to the tools is frozen', () => {
  const policy = executionPolicy('host', { files: 'read-only' });
  // The tools read the policy they were given at call time; if it stayed mutable, anything still holding the
  // object could widen its own confinement after the decision was made.
  assert.equal(Object.isFrozen(policy), true);
  assert.throws(() => {
    (policy as { files: FileEffect }).files = 'workspace-write';
  }, TypeError);
});

test('a policy that no longer matches its backend declaration is refused', (t) => {
  const stale = executionPolicy('seatbelt', { files: 'read-only', network: 'denied' });
  // A provider can re-register what it declares after a policy was snapshotted. Continuing under the older
  // policy would mean running with capabilities that nothing currently guarantees, so the disagreement has to
  // be refused rather than tolerated.
  registerExecutionCapabilities('seatbelt', () => ({
    processFiles: 'unrestricted',
    network: 'unrestricted',
    pathKind: 'local',
    links: 'refused',
  }));
  t.after(() => registerExecutionCapabilities('seatbelt', seatbeltCapabilities));
  assert.throws(
    () => requireExecutionCapabilities(stale, {}),
    /cannot enforce the declared policy/i,
  );
  // A policy that agrees with the new declaration still passes, so the check is not refusing blindly.
  const consistent: ExecutionPolicy = {
    ...stale,
    processFiles: 'unrestricted',
    network: 'unrestricted',
  };
  assert.doesNotThrow(() => requireExecutionCapabilities(consistent, {}));
});

test('a call that requires network capabilities is refused when the backend cannot provide them', () => {
  // No production caller passes a network requirement today — `execution-environment.ts` and `sandbox.ts`
  // only ever require `processFiles` — so this guard has no consumer yet. It is asserted directly so that it
  // cannot sit there untested and silently wrong in the meantime.
  const policy = executionPolicy('seatbelt', { network: 'denied' });
  assert.doesNotThrow(() => requireExecutionCapabilities(policy, { network: 'denied' }));
  assert.throws(
    () => requireExecutionCapabilities(policy, { network: 'unrestricted' }),
    /network capability does not satisfy this call/i,
  );
});

test('a policy handed to a call is re-snapshotted rather than reused', () => {
  const policy = executionPolicy('seatbelt', { files: 'read-only', network: 'denied' });
  let seen: ExecutionPolicy | undefined;
  withExecutionPolicy(policy, () => {
    seen = currentExecutionPolicy();
  });
  assert.ok(seen);
  // A fresh object: the caller keeps its own reference, so nothing it does to that object afterwards can
  // reach the confinement the call actually ran under.
  assert.notEqual(seen, policy);
  assert.equal(seen.files, 'read-only');
  assert.equal(seen.network, 'denied');
  assert.equal(Object.isFrozen(seen), true);
});
