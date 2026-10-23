// @test-serial windows-sandbox: Runs the real Windows program runner through a Host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { useAccountTests, windowsAccountTests } from './windows-account-fixture.ts';

useAccountTests();

test(
  'a real Host runs a Windows run_code program with durable receipts and no way out of the program VM',
  windowsAccountTests,
  async (t) => {
    let requests = 0;
    let output = '';
    const url = await httpFixture(t, (body, response) => {
      requests++;
      // The catalogue is the product's deferred one; all this case needs is that a program can be sent.
      assert.ok(
        body.tools.some((tool: { name: string }) => tool.name === 'run_code'),
        'run_code is offered',
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
                code: "const text=await tools.read_file({path:'seed.txt'}); await tools.write_file({path:'approved.txt',content:'approved'}); let reached='blocked'; try { reached=String(typeof console.log.constructor('return process')()); } catch {} return text.includes('seed') + ':' + reached;",
              },
            },
          ]),
        );
    });
    const host = await listeningHost(t, {
      YUANTU_SANDBOX: 'native',
      YUANTU_BASE_URL: url,
    });
    await writeFile(path.join(host.root, 'seed.txt'), 'seed');
    const { client } = await connectClient(host);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    await client.request('permission.update', {
      policy: { version: 1, rules: [{ kind: 'write', effect: 'allow' }] },
    });
    const session = await client.request('session.create', {});
    const result = await client.run(session.id, 'Use a program', {
      completion: {
        version: 1,
        objective: 'Write the approved fixture',
        constraints: [],
        steps: [],
        inputs: ['approved.txt'],
        acceptance: [
          {
            description: 'The program wrote the approved content',
            met: false,
            check: {
              id: 'program-output',
              kind: 'file-contains',
              path: 'approved.txt',
              expected: 'approved',
            },
          },
        ],
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(requests, 2);
    assert.match(output, /true:blocked/);
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
