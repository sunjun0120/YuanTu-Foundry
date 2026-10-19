import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { isMachineContext } from '../packages/protocol/context.ts';

/**
 * A model endpoint that holds every answer until `release` is called, and names in each answer the marker
 * found in its request. Holding the answers is what proves overlap: a Host that ran the sessions one after the
 * other would never have two requests open at once.
 */
async function heldEndpoint(t: Parameters<typeof httpFixture>[0], markers: readonly string[]) {
  const held = new Map<string, ServerResponse>();
  let arrived: () => void = () => {};
  const url = await httpFixture(t, (body, res) => {
    const text = JSON.stringify(body.messages ?? []);
    const marker = markers.find((candidate) => text.includes(candidate)) ?? 'unknown';
    held.set(marker, res);
    arrived();
  });
  return {
    url,
    /** Resolve once `count` distinct requests are being held. */
    waitFor: (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`only ${held.size} held`)), 8000);
        const check = () => {
          if (held.size < count) return;
          clearTimeout(timer);
          resolve();
        };
        arrived = check;
        check();
      }),
    release: (marker: string) => {
      const res = held.get(marker);
      assert.ok(res, `no held request for ${marker}`);
      sendFrames(res, frames(`reply-${marker}`));
    },
  };
}

async function sessions(t: Parameters<typeof httpFixture>[0], count: number, env = {}) {
  let ids: string[] = [];
  const markers = Array.from({ length: count }, (_, index) => `marker-${index}`);
  const endpoint = await heldEndpoint(t, markers);
  const host = await listeningHost(
    t,
    { YUANTU_BASE_URL: endpoint.url, YUANTU_SESSION_TITLES: '0', ...env },
    (file) => {
      const store = new SessionStore(file);
      ids = markers.map(() => store.create(path.dirname(file)).id);
      store.close();
    },
  );
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  return { client, ids, markers, endpoint };
}

const transcriptOf = async (
  client: Awaited<ReturnType<typeof sessions>>['client'],
  sessionId: string,
) => {
  const { messages } = (await client.request('session.get', { sessionId })) as {
    messages: { role: string; content: string }[];
  };
  return {
    users: messages
      .filter((m) => m.role === 'user' && !isMachineContext(m.content))
      .map((m) => m.content),
    assistant: messages.filter((m) => m.role === 'assistant').map((m) => m.content),
  };
};

test('two sessions run at the same time and keep their own transcripts', async (t) => {
  const { client, ids, markers, endpoint } = await sessions(t, 2);
  const first = client.run(ids[0]!, `First ${markers[0]}`);
  const second = client.run(ids[1]!, `Second ${markers[1]}`);
  // Both model requests are open at once: the Host admitted the second run while the first was still running.
  await endpoint.waitFor(2);
  endpoint.release(markers[1]!);
  assert.equal((await second).status, 'completed');
  endpoint.release(markers[0]!);
  assert.equal((await first).status, 'completed');
  for (const [index, id] of ids.entries()) {
    const transcript = await transcriptOf(client, id);
    assert.deepEqual(transcript.users, [`${index ? 'Second' : 'First'} ${markers[index]}`]);
    assert.deepEqual(transcript.assistant, [`reply-${markers[index]}`]);
  }
});

test('cancelling one running session leaves the other session running', async (t) => {
  const { client, ids, markers, endpoint } = await sessions(t, 2);
  const first = client.run(ids[0]!, `First ${markers[0]}`);
  const second = client.run(ids[1]!, `Second ${markers[1]}`);
  await endpoint.waitFor(2);
  assert.deepEqual(await client.request('run.cancel', { sessionId: ids[0]! }), { cancelled: true });
  assert.equal((await first).status, 'cancelled');
  endpoint.release(markers[1]!);
  assert.equal((await second).status, 'completed');
});

test('a full Host refuses a third session explicitly and admits it once a slot frees', async (t) => {
  const { client, ids, markers, endpoint } = await sessions(t, 3);
  const first = client.run(ids[0]!, `First ${markers[0]}`);
  const second = client.run(ids[1]!, `Second ${markers[1]}`);
  await endpoint.waitFor(2);
  await assert.rejects(
    client.run(ids[2]!, `Third ${markers[2]}`),
    /already has an active run in each of its 2 run slots/,
  );
  // The same session is refused for its own reason, not the Host's.
  await assert.rejects(client.run(ids[0]!, 'again'), /This session already has an active run/);
  endpoint.release(markers[0]!);
  assert.equal((await first).status, 'completed');
  const third = client.run(ids[2]!, `Third ${markers[2]}`);
  await endpoint.waitFor(3);
  endpoint.release(markers[2]!);
  endpoint.release(markers[1]!);
  assert.equal((await third).status, 'completed');
  assert.equal((await second).status, 'completed');
});

test('YUANTU_HOST_MAX_RUNS=1 keeps the Host globally serial', async (t) => {
  const { client, ids, markers, endpoint } = await sessions(t, 2, { YUANTU_HOST_MAX_RUNS: '1' });
  const first = client.run(ids[0]!, `First ${markers[0]}`);
  await endpoint.waitFor(1);
  await assert.rejects(
    client.run(ids[1]!, `Second ${markers[1]}`),
    /This Host already has an active run(?! in each)/,
  );
  endpoint.release(markers[0]!);
  assert.equal((await first).status, 'completed');
});
