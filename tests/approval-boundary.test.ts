import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { describeExecutionBoundary, executionPolicy } from '../packages/tools/execution-policy.ts';
import { windowsAccountCapabilities } from '../packages/tools/execution-capabilities.ts';
import { createApprover } from '../apps/cli/terminal.ts';
import type { Approval, ApprovalDecisionSource } from '../packages/protocol/index.ts';
import { createRunApprover } from '../apps/agent-host/approvals.ts';
import type { Options } from '../apps/shared/args.ts';
import type { SessionStore } from '../packages/storage/sqlite.ts';

test('the boundary sentence says what each backend declares, and no more', () => {
  assert.match(describeExecutionBoundary(executionPolicy('host')), /no operating-system isolation/);
  assert.match(describeExecutionBoundary(executionPolicy('host')), /can reach the network/);
  // The Windows token backend is a partial write boundary: the person approving must hear that reads and the
  // network stay open, because that is the part a "sandboxed" label would hide.
  const windows = describeExecutionBoundary({
    ...executionPolicy('host'),
    processFiles: 'workspace-write-partial',
  });
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

test('the Windows account backend denies the network unless a policy names it', () => {
  assert.equal(
    windowsAccountCapabilities({ mode: 'windows-account', image: 'native' }).network,
    'denied',
  );
  assert.equal(
    windowsAccountCapabilities({
      mode: 'windows-account',
      image: 'native',
      network: 'unrestricted',
    }).network,
    'unrestricted',
  );
});

test('a command that asks for the network is approved and run as that escalated call', async () => {
  const registry = new ToolRegistry();
  const seen: (string | undefined)[] = [];
  registry.register({
    name: 'fake_command',
    description: 'A command-permission tool that can ask for the network.',
    inputSchema: {
      type: 'object',
      properties: { network: { type: 'boolean' } },
      additionalProperties: false,
    },
    permission: 'command',
    requestsNetwork: (args) => args.network === true,
    execute: async (_args, ctx) => {
      seen.push(ctx.executionPolicy?.network);
      return { content: 'ran', isError: false };
    },
  });
  const approvals: Approval[] = [];
  const context = {
    signal: new AbortController().signal,
    approve: async (approval: Approval) => {
      approvals.push(approval);
      return true;
    },
    executionPolicy: executionPolicy('seatbelt'),
  };
  await registry.execute({ id: '1', name: 'fake_command', arguments: {} }, context);
  await registry.execute({ id: '2', name: 'fake_command', arguments: { network: true } }, context);
  assert.deepEqual(seen, ['denied', 'unrestricted']);
  assert.equal(approvals[0]!.escalation, undefined);
  assert.equal(approvals[0]!.boundary?.network, 'denied');
  assert.deepEqual(approvals[1]!.escalation, { network: 'unrestricted' });
  assert.equal(approvals[1]!.boundary?.network, 'unrestricted');
  assert.match(approvals[1]!.description, /it can reach the network/);
  // A session that already has the network has nothing to escalate.
  await registry.execute(
    { id: '3', name: 'fake_command', arguments: { network: true } },
    { ...context, executionPolicy: executionPolicy('host') },
  );
  assert.equal(approvals[2]!.escalation, undefined);
});

test('launch options never grant a network escalation', async () => {
  const approve = createApprover(
    { allowCommand: true, json: true } as unknown as Parameters<typeof createApprover>[0],
    undefined,
  );
  const call = (escalation?: Approval['escalation']) =>
    approve(
      {
        kind: 'command',
        description: '',
        toolCall: { id: 'c', name: 'run_command', arguments: { command: 'npm install' } },
        ...(escalation ? { escalation } : {}),
      },
      new AbortController().signal,
    );
  assert.equal(await call(), true);
  assert.equal(await call({ network: 'unrestricted' }), false);
});

test("the Host's own approval deadline is a timeout, not a missing responder", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: unknown[] = [];
  const approvalSources = new WeakMap<object, ApprovalDecisionSource>();
  const approve = createRunApprover({
    options: {} as Options,
    store: {} as SessionStore,
    sessionId: 's1',
    policy: () => undefined,
    wake: false,
    unattendedTaskId: undefined,
    runId: () => 'r1',
    approvals: new Map(),
    approvalSources,
    send: (data) => sent.push(data),
  });
  const approval: Approval = {
    kind: 'command',
    description: 'echo',
    toolCall: {} as Approval['toolCall'],
  };
  const decision = approve(approval, new AbortController().signal);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(120_000);
  assert.equal(await decision, false);
  assert.equal(approve.decisionSource?.(approval), 'timeout');
});
