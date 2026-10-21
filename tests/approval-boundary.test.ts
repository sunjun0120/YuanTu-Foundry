import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { describeExecutionBoundary, executionPolicy } from '../packages/tools/execution-policy.ts';
import type { Approval } from '../packages/protocol/index.ts';

test('the boundary sentence says what each backend declares, and no more', () => {
  assert.match(describeExecutionBoundary(executionPolicy('host')), /no operating-system isolation/);
  assert.match(describeExecutionBoundary(executionPolicy('host')), /can reach the network/);
  // The Windows token backend is a partial write boundary: the person approving must hear that reads and the
  // network stay open, because that is the part a "sandboxed" label would hide.
  const windows = describeExecutionBoundary(executionPolicy('windows'));
  assert.match(windows, /only partly confined/);
  assert.match(windows, /read files anywhere/);
  assert.match(windows, /can reach the network/);
  const seatbelt = describeExecutionBoundary(executionPolicy('seatbelt'));
  assert.match(seatbelt, /confined to the workspace/);
  assert.match(seatbelt, /network access is blocked/);
  assert.match(
    describeExecutionBoundary(executionPolicy('seatbelt', { files: 'read-only' })),
    /no file writes/,
  );
});

test('a read-only refusal is reported as policy, not as a user denial', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'fake_write',
    description: 'A write-permission tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'write',
    execute: async () => ({ content: 'wrote', isError: false }),
  });
  const approve = Object.assign(async () => false, {
    decisionReason: () => 'read-only',
  });
  const result = await registry.execute(
    { id: '1', name: 'fake_write', arguments: {} },
    {
      signal: new AbortController().signal,
      readOnly: true,
      approve,
      executionPolicy: executionPolicy('host'),
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /not available in this read-only run/);
  assert.match(result.content, /exit_plan_mode/);
  assert.doesNotMatch(result.content, /Permission denied by user/);
});

test('a command approval carries the boundary of the backend it will run on; other kinds do not', async () => {
  const registry = new ToolRegistry();
  const parameters = { type: 'object', properties: {}, additionalProperties: false };
  registry.register({
    name: 'fake_command',
    description: 'A command-permission tool.',
    inputSchema: parameters,
    permission: 'command',
    execute: async () => ({ content: 'ran', isError: false }),
  });
  registry.register({
    name: 'fake_write',
    description: 'A write-permission tool.',
    inputSchema: parameters,
    permission: 'write',
    execute: async () => ({ content: 'wrote', isError: false }),
  });
  const approvals: Approval[] = [];
  const context = {
    signal: new AbortController().signal,
    approve: async (approval: Approval) => {
      approvals.push(approval);
      return true;
    },
    executionPolicy: executionPolicy('host'),
  };
  await registry.execute({ id: '1', name: 'fake_command', arguments: {} }, context);
  await registry.execute({ id: '2', name: 'fake_write', arguments: {} }, context);
  assert.match(approvals[0]!.description, /\nIsolation: Runs on the host/);
  assert.doesNotMatch(approvals[1]!.description, /Isolation:/);
  // The same facts as data, so the desktop can say them in the reader's language.
  assert.deepEqual(approvals[0]!.boundary, {
    processFiles: 'unrestricted',
    network: 'unrestricted',
  });
  assert.equal(approvals[1]!.boundary, undefined);
});
