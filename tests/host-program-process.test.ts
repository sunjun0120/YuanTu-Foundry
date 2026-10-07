import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';

test(
  'a real Host runs Windows PTC with durable receipts and no direct fs write grant',
  { skip: process.platform !== 'win32' },
  async (t) => {
    let requests = 0;
    let output = '';
    const url = await httpFixture(t, (body, response) => {
      requests++;
      assert.deepEqual(
        body.tools.map((tool: { name: string }) => tool.name),
        ['run_code'],
      );
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block: { type: string }) => block.type === 'tool_result')
        : undefined;
      if (result) {
        output = JSON.stringify(result.content);
        sendFrames(response, frames('done'));
      } else
        sendFrames(
          response,
          frames('', [
            {
              id: 'program',
              name: 'run_code',
              input: {
                code: "const text=await tools.read_file({path:'seed.txt'}); await tools.write_file({path:'approved.txt',content:'approved'}); const p=console.log.constructor('return process')(); return text.includes('seed') + ':' + p.permission.has('fs.write');",
              },
            },
          ]),
        );
    });
    const host = await listeningHost(t, {
      YUANTU_SANDBOX: 'windows',
      YUANTU_TOOL_MODE: 'ptc',
      YUANTU_BASE_URL: url,
    });
    await writeFile(path.join(host.root, 'seed.txt'), 'seed');
    const { client } = await connectClient(host.port);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    await client.request('permission.update', {
      policy: { version: 1, rules: [{ kind: 'write', effect: 'allow' }] },
    });
    const session = await client.request('session.create', {});
    const result = await client.run(session.id, 'Use a program');
    assert.equal(result.status, 'completed', result.error);
    assert.equal(requests, 2);
    assert.match(output, /true:false/);
    assert.equal(await readFile(path.join(host.root, 'approved.txt'), 'utf8'), 'approved');
    const store = new SessionStore(host.dbPath);
    try {
      const records = store
        .events(session.id)
        .filter((event) => event.type === 'program.call.settled');
      assert.equal(records.length, 2);
      assert.ok(records.every((event) => event.data.state === 'known'));
    } finally {
      store.close();
    }
  },
);
