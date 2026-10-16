import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceMaintenanceCommand } from '../apps/desktop/workspace-maintenance-contract.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentHostClient } from '../packages/client/host-client.ts';
import type { HostTransport, HostTransportExit } from '../packages/client/host-transport.ts';
import { maintainWorkspace } from '../apps/desktop/workspace-maintenance.ts';

test('workspace writes wait for policy sync and refuse failed sync or a changed session', async () => {
  let resolve!: () => void,
    reject!: (error: Error) => void,
    calls = 0,
    current = true;
  const policyReady = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const options = {
    service: {
      async maintainOrphanWorkspace() {
        calls++;
      },
      async orphanWorkspaces() {
        return [];
      },
    },
    command: { type: 'archive' as const, bindingId: 'orphan' },
    workspace: '/project',
    policyReady,
    isCurrent: () => current,
  };
  const first = maintainWorkspace(options);
  const failure = assert.rejects(first, /policy sync rejected/);
  await Promise.resolve();
  assert.equal(calls, 0);
  reject(new Error('policy sync rejected'));
  await failure;
  assert.equal(calls, 0);
  const nextReady = new Promise<void>((yes) => {
    resolve = yes;
  });
  const second = maintainWorkspace({ ...options, policyReady: nextReady });
  const changed = assert.rejects(second, /operation.*progress/i);
  current = false;
  resolve();
  await changed;
  assert.equal(calls, 0);
  current = true;
  await maintainWorkspace({ ...options, policyReady: Promise.resolve() });
  assert.equal(calls, 1);
});

test('workspace maintenance requests outlive the ordinary deadline while quick queries still time out', async () => {
  let deliver: (line: string) => void = () => {};
  let exited: (event: HostTransportExit) => void = () => {};
  const pending: { id: string; method: string }[] = [];
  const transport: HostTransport = {
    label: 'delayed workspace fixture',
    pid: undefined,
    writable: true,
    send(line) {
      const request = JSON.parse(line) as { id: string; method: string };
      if (request.method === 'host.info')
        queueMicrotask(() =>
          deliver(
            JSON.stringify({
              id: request.id,
              result: {
                protocolVersion: 1,
                runtime: 'yuantu',
                workspace: process.cwd(),
                capabilities: [],
              },
            }),
          ),
        );
      else pending.push(request);
      return true;
    },
    onLine(listener) {
      deliver = listener;
      return () => {};
    },
    onExit(listener) {
      exited = listener;
      return () => {};
    },
    onError: () => () => {},
    onDiagnostic: () => () => {},
    end() {
      exited({ code: 0, signal: null });
    },
    kill() {},
  };
  const client = new AgentHostClient({ transport, requestTimeoutMs: 20 });
  try {
    await client.start();
    let settled = 0;
    const results = [
      'workspace.archive',
      'workspace.remove',
      'workspace.restore',
      'workspaces.orphaned',
    ].map((method) =>
      client
        .request(method as 'workspace.archive', { bindingId: 'fixture-binding' })
        .finally(() => {
          settled++;
        }),
    );
    const collection = Promise.allSettled(results);
    const quick = assert.rejects(client.request('session.list', {}), /timed out|timeout/i);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await quick;
    assert.equal(settled, 0, 'maintenance must remain pending until the Host answers');
    for (const request of pending.filter((value) => value.method !== 'session.list'))
      deliver(JSON.stringify({ id: request.id, result: {} }));
    assert.ok((await collection).every((result) => result.status === 'fulfilled'));
  } finally {
    await client.stop();
  }
});

test('desktop workspace maintenance accepts only inventory and explicit binding operations', () => {
  assert.deepEqual(parseWorkspaceMaintenanceCommand({ type: 'list' }), { type: 'list' });
  for (const action of ['archive', 'remove', 'restore'])
    assert.deepEqual(
      parseWorkspaceMaintenanceCommand({ type: action, bindingId: 'workspace-123' }),
      { type: action, bindingId: 'workspace-123' },
    );
  for (const input of [
    null,
    [],
    { type: 'list', includeRemoved: 'yes' },
    { type: 'remove' },
    { type: 'remove', bindingId: '../other' },
    { type: 'remove', bindingId: 'a', sessionId: 'other' },
    { type: 'list', workspace: '/other' },
    { type: 'run', bindingId: 'x' },
  ])
    assert.throws(() => parseWorkspaceMaintenanceCommand(input));
});

test('orphan result lookup uses a binding index on new and already-current databases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-orphan-index-'));
  let store: SessionStore | undefined;
  let inspection: DatabaseSync | undefined;
  try {
    const file = path.join(root, 'sessions.sqlite');
    store = new SessionStore(file);
    inspection = new DatabaseSync(file);
    const query =
      'EXPLAIN QUERY PLAN SELECT * FROM workspace_results WHERE binding_id=? ORDER BY created_at,id';
    assert.match(
      JSON.stringify(inspection.prepare(query).all('binding-1')),
      /USING INDEX workspace_results_binding/,
    );
    // Simulate a v30 database written before the additional, recomputable index existed.
    inspection.exec('DROP INDEX workspace_results_binding');
    inspection.close();
    inspection = undefined;
    store.close();
    store = new SessionStore(file);
    inspection = new DatabaseSync(file);
    assert.match(
      JSON.stringify(inspection.prepare(query).all('binding-1')),
      /USING INDEX workspace_results_binding/,
    );
  } finally {
    inspection?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
