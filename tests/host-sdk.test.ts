import assert from 'node:assert/strict';
import test from 'node:test';
import { negotiateHostVersion, validateHostInfo } from '../packages/protocol/host-wire.ts';
import { AgentHostClient, HostRequestError } from '../packages/sdk/index.ts';
import type { HostTransport } from '../packages/client/host-transport.ts';

test('v1 accepts legacy and additive metadata but rejects incompatible versions', () => {
  assert.equal(negotiateHostVersion({}), 1);
  assert.equal(negotiateHostVersion({ protocolVersions: [2, 1] }), 1);
  assert.throws(() => negotiateHostVersion({ protocolVersions: [2] }), /protocol/);
  for (const versions of [[], [0], ['1'], 1])
    assert.throws(() => negotiateHostVersion({ protocolVersions: versions }));
  const info = {
    protocolVersion: 1,
    runtime: 'yuantu',
    workspace: process.cwd(),
    capabilities: ['sessions'],
    extra: true,
  };
  assert.equal(validateHostInfo(info), info);
  assert.throws(() => validateHostInfo({ ...info, capabilities: [123] }));
  assert.throws(() => validateHostInfo({ ...info, protocolVersion: 2 }));
  assert.throws(() => validateHostInfo(null));
});

function transport(reply: (packet: { id: string; method: string; params: unknown }) => unknown) {
  let line: (line: string) => void = () => {};
  let exit: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  let sends = 0;
  const link: HostTransport = {
    label: 'fixture',
    pid: undefined,
    writable: true,
    send(value) {
      sends++;
      const packet = JSON.parse(value);
      const answer =
        packet.method === 'host.info'
          ? {
              result: {
                protocolVersion: 1,
                runtime: 'yuantu',
                workspace: process.cwd(),
                capabilities: [],
              },
            }
          : reply(packet);
      if (answer) queueMicrotask(() => line(JSON.stringify({ id: packet.id, ...answer })));
      return true;
    },
    end() {
      queueMicrotask(() => exit({ code: 0, signal: null }));
    },
    kill() {
      exit({ code: null, signal: 'SIGTERM' });
    },
    onLine(callback) {
      line = callback;
      return () => {};
    },
    onError() {
      return () => {};
    },
    onExit(callback) {
      exit = callback;
      return () => {};
    },
    onDiagnostic() {
      return () => {};
    },
  };
  return { link, sends: () => sends };
}

test('SDK exposes typed remote errors and never retries uncertain timeouts', async () => {
  const remote = transport(() => ({ error: { message: 'not supported', code: 'UNSUPPORTED' } }));
  const client = new AgentHostClient({ transport: remote.link, requestTimeoutMs: 20 });
  await client.start();
  await assert.rejects(
    client.request('session.create', {}),
    (error: unknown) =>
      error instanceof HostRequestError &&
      error.code === 'UNSUPPORTED' &&
      error.method === 'session.create' &&
      !error.outcomeUnknown,
  );
  await client.stop();
  const silent = transport(() => null);
  const next = new AgentHostClient({ transport: silent.link, requestTimeoutMs: 20 });
  await next.start();
  await assert.rejects(
    next.request('session.create', {}),
    (error: unknown) =>
      error instanceof HostRequestError && error.code === 'REQUEST_TIMEOUT' && error.outcomeUnknown,
  );
  assert.equal(silent.sends(), 2);
  await next.stop();
});

test('synchronous transport send failure is settled without leaving a pending timer', async () => {
  const remote = transport(() => {
    throw new Error('send failed');
  });
  const client = new AgentHostClient({ transport: remote.link, requestTimeoutMs: 20 });
  await client.start();
  await assert.rejects(client.request('session.create', {}), /send failed/);
  await client.stop();
});
