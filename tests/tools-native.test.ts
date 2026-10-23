// @test-serial windows-sandbox: Executes npm validation under the Windows sandbox account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { tempRoot } from './temp-fixture.ts';
import { useAccountTests, windowsAccountTests } from './windows-account-fixture.ts';

useAccountTests();

async function fixture(t: test.TestContext) {
  const root = await tempRoot(t, 'yuantu-tools-');
  return { root, tools: createTools(root) };
}
const ctx = () => ({ signal: new AbortController().signal, approve: async () => true });
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});

test(
  'Windows validation runs npm scripts through the native command interpreter',
  windowsAccountTests,
  async (t) => {
    const { root, tools } = await fixture(t);
    t.after(() => tools.close());
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node fixture.cjs' } }),
    );
    await writeFile(
      path.join(root, 'fixture.cjs'),
      "require('node:fs').writeFileSync('verified.txt', 'actual execution'); console.log('VALIDATION_MARKER');",
    );
    const previous = process.env.YUANTU_SANDBOX;
    process.env.YUANTU_SANDBOX = 'native';
    try {
      const result = await tools.execute(call('run_validation', { id: 'npm:test' }), ctx());
      assert.equal(result.isError, false, result.content);
      assert.match(JSON.parse(result.content).output, /VALIDATION_MARKER/);
      assert.equal(await readFile(path.join(root, 'verified.txt'), 'utf8'), 'actual execution');
    } finally {
      if (previous === undefined) delete process.env.YUANTU_SANDBOX;
      else process.env.YUANTU_SANDBOX = previous;
    }
  },
);
