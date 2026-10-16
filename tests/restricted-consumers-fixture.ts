import test from 'node:test';
import { mkdtemp, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

export const windows = { skip: process.platform !== 'win32', timeout: 60000 };

export const native = {
  skip: process.platform !== 'win32' && process.platform !== 'darwin',
  timeout: 60000,
};

export const fixture = path.resolve('tests/lsp-fixture.ts');

export const nativeMode = process.platform === 'darwin' ? 'seatbelt' : 'windows';

export const context = (mode: 'host' | 'windows' | 'seatbelt' = nativeMode): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  executionPolicy: executionPolicy(mode),
});

export async function waitUntil(check: () => boolean | Promise<boolean>, ms = 12000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting for independent evidence');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function exists(file: string) {
  return Boolean(await stat(file).catch(() => undefined));
}

export const resources = new Map<string, Array<() => unknown | Promise<unknown>>>();

export function own(root: string, cleanup: () => unknown | Promise<unknown>) {
  resources.get(root)!.push(cleanup);
}

export async function workspace(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yuantu-restricted-consumer-')));
  resources.set(root, []);
  t.after(async () => {
    for (const cleanup of resources.get(root)!) await cleanup();
    resources.delete(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}
