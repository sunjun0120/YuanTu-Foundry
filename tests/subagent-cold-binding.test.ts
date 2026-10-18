/**
 * A resident child that a new process has to rebuild must come back in the workspace its delegation named.
 *
 * A residency is process memory; the binding is durable. Resuming without it handed the child the parent's
 * tools, journal and export path — an isolated child writing into the tree it was delegated to stay out of.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createResidentMessageTool } from '../packages/core/run-residency.ts';
import type { WorkspaceBinding } from '../packages/protocol/workspaces.ts';
import type { SessionStatistics } from '../packages/protocol/statistics.ts';
import type { ToolContext } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

async function fixture(t: test.TestContext) {
  const { root, store } = await storeFixture(t, 'yuantu-cold-binding-');
  const parent = store.create(root);
  const child = store.create(root, parent.id);
  store.recordEvent(parent.id, 'subagent.assigned', {
    id: 'child-1',
    role: 'general',
    objective: 'edit the isolated tree',
    childSessionId: child.id,
  });
  const binding: WorkspaceBinding = {
    id: 'binding-1',
    sessionId: child.id,
    parentSessionId: parent.id,
    projectRoot: root,
    executionRoot: path.join(root, '.yuantu', 'worktrees', 'child'),
    repositoryRoot: root,
    kind: 'worktree',
    snapshotId: 'snapshot-1',
    baseCommit: 'commit-1',
    state: 'ready',
  };
  return { root, store, parent, child, binding };
}

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

test('a cold-resumed child is rebuilt with its durable workspace binding', async (t) => {
  const { store, parent, child, binding } = await fixture(t);
  let received: WorkspaceBinding | undefined;
  let validated = false;
  let opened = false;
  const tool = createResidentMessageTool({
    store,
    parentSessionId: parent.id,
    depth: 0,
    residency: {
      get: () => undefined,
      open: () => {
        opened = true;
        throw new Error('the turn fixture was never expected to run');
      },
    } as never,
    childTurns: ((input: { binding?: WorkspaceBinding }) => {
      received = input.binding;
      throw new Error('stop after the turn builder chose its workspace');
    }) as never,
    workspaceManager: {
      resolve: (sessionId: string) => {
        assert.equal(sessionId, child.id);
        return binding;
      },
      validate: async (candidate: WorkspaceBinding) => {
        assert.equal(candidate, binding);
        validated = true;
      },
    },
    emit: () => {},
    statistics: {} as SessionStatistics,
    usage: { inputTokens: 0, outputTokens: 0 },
    nextMessageId: () => 1,
  });

  const result = await tool.execute(
    { childSessionId: child.id, message: 'now edit it' },
    context(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /stop after the turn builder/);
  assert.equal(received, binding, 'the child turn builder receives the child binding');
  assert.equal(validated, true, 'the binding is validated before the turn is built');
  assert.equal(opened, false, 'no activation was opened on the failure path');
});

test('a cold resume refuses when the durable binding no longer validates', async (t) => {
  const { store, parent, child, binding } = await fixture(t);
  let built = false;
  const tool = createResidentMessageTool({
    store,
    parentSessionId: parent.id,
    depth: 0,
    residency: { get: () => undefined, open: () => assert.fail('no activation') } as never,
    childTurns: (() => {
      built = true;
      assert.fail('a rejected binding must not build a turn');
    }) as never,
    workspaceManager: {
      resolve: () => binding,
      validate: async () => {
        throw new Error('the isolated workspace directory is gone');
      },
    },
    emit: () => {},
    statistics: {} as SessionStatistics,
    usage: { inputTokens: 0, outputTokens: 0 },
    nextMessageId: () => 1,
  });

  const result = await tool.execute(
    { childSessionId: child.id, message: 'now edit it' },
    context(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /isolated workspace directory is gone/);
  assert.equal(
    built,
    false,
    'the invalid binding is refused, not replaced by the parent workspace',
  );
});
