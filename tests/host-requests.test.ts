import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRequests } from '../packages/client/host-requests.ts';
import { HostRequestError } from '../packages/protocol/host-wire.ts';

test('request settlement removes timers and late responses have no recipient', async () => {
  const requests = new HostRequests();
  let rejected = 0;
  let resolved = 0;
  requests.add(
    'first',
    {
      method: 'session.create',
      resolve: () => {
        resolved++;
      },
      reject: () => {
        rejected++;
      },
    },
    20,
  );
  requests.take('first')!.resolve({ id: 'session' });
  assert.equal(requests.size, 0);
  assert.equal(requests.take('first'), undefined);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(resolved, 1);
  assert.equal(rejected, 0);
});

test('timeout settles exactly once with an unknown execution outcome', async () => {
  const requests = new HostRequests();
  const error = await new Promise<Error>((resolve) =>
    requests.add(
      'timeout',
      {
        method: 'session.create',
        resolve: () => assert.fail('unexpected response'),
        reject: resolve,
      },
      10,
    ),
  );
  assert.ok(error instanceof HostRequestError);
  assert.equal(error.code, 'REQUEST_TIMEOUT');
  assert.equal(error.outcomeUnknown, true);
  assert.equal(requests.take('timeout'), undefined);
});

test('connection failure rejects all pending requests and cancels their deadlines', async () => {
  const requests = new HostRequests();
  const errors: Error[] = [];
  const failure = new Error('link failed');
  for (const id of ['a', 'b'])
    requests.add(
      id,
      {
        method: 'session.list',
        resolve: () => assert.fail('unexpected response'),
        reject: (error) => {
          errors.push(error);
        },
      },
      10,
    );
  requests.rejectAll(failure);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.size, 0);
  assert.deepEqual(errors, [failure, failure]);
});

test('duplicate pending IDs are refused without replacing the original recipient', () => {
  const requests = new HostRequests();
  const entry = { method: 'session.list' as const, resolve: () => {}, reject: () => {} };
  requests.add('same', entry, 0);
  assert.throws(() => requests.add('same', entry, 0), /Duplicate/);
  assert.equal(requests.take('same')?.method, entry.method);
});
