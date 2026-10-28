import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { startHost, connectClient } from './host-process-fixture.ts';

test('the desktop Host automatically verifies a plain request with no caller-supplied contract', async (t) => {
  let requests = 0;
  let offered = false;
  const url = await httpFixture(t, (body, res) => {
    offered ||= JSON.stringify(body.tools ?? []).includes('verify_work');
    sendFrames(
      res,
      requests++ === 0
        ? frames('', [
            {
              id: 'check',
              name: 'verify_work',
              input: {
                commands: [
                  {
                    command: process.execPath,
                    args: [
                      '-e',
                      "if(require('node:fs').readFileSync('out.txt','utf8')!=='fixed')process.exit(1)",
                    ],
                  },
                ],
                inputs: ['out.txt'],
              },
            },
            { id: 'write', name: 'write_file', input: { path: 'out.txt', content: 'fixed' } },
          ])
        : frames('Done'),
    );
  });
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  host.beforeStop(() => client.stop());
  await client.start();
  client.subscribe((event) => {
    if (event.type === 'approval.required')
      void client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: true,
      });
  });
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Create and verify the output');
  assert.equal(offered, true);
  assert.equal(result.completion?.state, 'verified', JSON.stringify(result));
  const record = await client.request('completion.current', { sessionId: session.id });
  assert.equal(record?.source, 'automatic');
  assert.equal(record?.evidence?.checks[0]?.command?.exitCode, 0);
});
