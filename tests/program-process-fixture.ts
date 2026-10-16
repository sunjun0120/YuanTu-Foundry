import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import type { ToolContext, ToolCatalog } from '../packages/protocol/index.ts';

export async function fixture(t: test.TestContext, mode: 'host' | 'windows' = 'host') {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-program-process-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: executionPolicy(mode),
  };
  const catalog: ToolCatalog = {
    specs: tools.specs({ mode: 'native' }),
    mode: (call) => tools.executionMode(call),
    parallelLimit: 2,
    invoke: (call, signal) => tools.execute(call, { ...context, signal: signal ?? context.signal }),
  };
  const run = (code: string) =>
    tools.execute(
      { id: 'program', name: 'run_code', arguments: { code } },
      { ...context, catalog },
    );
  return { root, tools, context, catalog, run };
}
