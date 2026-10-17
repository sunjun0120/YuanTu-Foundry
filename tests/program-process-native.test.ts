// @test-serial windows-sandbox: Runs the real Windows program backend and its approval boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './program-process-fixture.ts';

test(
  'a Windows program uses the selected backend and RPC writes still require approval',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { tools, context, root } = await fixture(t, 'windows', { escaped: true });
    let approvals = 0;
    const chosen = {
      ...context,
      approve: async () => {
        approvals++;
        return true;
      },
    };
    const result = await tools.execute(
      {
        id: 'win-program',
        name: 'run_code',
        arguments: {
          code: "await tools.write_file({path:'approved.txt',content:'approved'}); const p=escapedProcess; return p.permission.has('fs.write') + ':' + p.pid;",
        },
      },
      {
        ...chosen,
        catalog: {
          specs: tools.specs({ mode: 'native' }),
          mode: (call) => tools.executionMode(call),
          parallelLimit: 2,
          invoke: (call, signal) =>
            tools.execute(call, { ...chosen, signal: signal ?? chosen.signal }),
        },
      },
    );
    assert.equal(result.isError, false, result.content);
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'approved');
    assert.match(result.content, /^false:\d+/);
    assert.notEqual(Number(result.content.split(':')[1]?.split('\n')[0]), process.pid);
  },
);
