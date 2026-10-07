import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import ts from 'typescript';
import { HookRegistry } from '../packages/tools/hooks.ts';
import { HookRegistry as LegacyHooks, ToolRegistry } from '../packages/tools/registry.ts';
import { DeferredApprovalError } from '../packages/protocol/failure.ts';
import { DeferredApprovalError as LegacyDeferred } from '../packages/core/approval-deferred.ts';
import { PIPELINE_STAGES } from '../packages/protocol/tool-pipeline.ts';
import { PIPELINE_STAGES as LegacyStages } from '../packages/tools/pipeline.ts';
import type { PermissionPolicyView } from '../packages/protocol/permissions.ts';

test('legacy extension and approval entrypoints keep the same runtime identities', () => {
  assert.equal(HookRegistry, LegacyHooks);
  assert.equal(DeferredApprovalError, LegacyDeferred);
  assert.ok(new LegacyDeferred() instanceof DeferredApprovalError);
  assert.equal(PIPELINE_STAGES, LegacyStages);
});

test('standalone hooks keep ordered registrations and cooperative cancellation', async () => {
  const hooks = new HookRegistry();
  const calls: string[] = [];
  const dispose = hooks.register({
    promptSubmit: () => {
      calls.push('first');
      return { prompt: 'changed' };
    },
  });
  hooks.register({
    promptSubmit: (context) => {
      calls.push(context.prompt);
    },
  });
  const context = { sessionId: 's', prompt: 'original' };
  const controller = new AbortController();
  assert.equal((await hooks.promptSubmit(context, controller.signal)).prompt, 'changed');
  assert.deepEqual(calls, ['first', 'changed']);
  dispose();
  calls.length = 0;
  await hooks.promptSubmit(context, controller.signal);
  assert.deepEqual(calls, ['original']);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleaned = false;
  hooks.register({
    promptSubmit: async (_context, signal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cleaned = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
  });
  const pending = hooks.promptSubmit(context, controller.signal);
  await started;
  controller.abort(new Error('cancelled'));
  const result = await pending;
  assert.equal(cleaned, true);
  assert.match(result.failures.join(';'), /cancelled/);
  await hooks.close();
});

test('tool catalogs accept a permission view without a concrete core policy', async () => {
  const policy: PermissionPolicyView = {
    decide: () => 'deny',
    deniesEveryCall: (tool) => tool.permission !== undefined,
  };
  const tools = new ToolRegistry();
  tools.register({
    name: 'write_example',
    description: 'test',
    permission: 'write',
    inputSchema: { type: 'object' },
    execute: async () => ({ isError: false, content: 'done' }),
  });
  assert.equal(
    tools.specs({ policy }).some((tool) => tool.name === 'write_example'),
    false,
  );
  await tools.close();
});

test('isolated lifecycle and plan components do not load large implementation modules', async () => {
  for (const entry of [
    'packages/tools/hooks.ts',
    'packages/core/plan-tools.ts',
    'packages/storage/plans.ts',
  ]) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile!.inputs).map((name) => name.replaceAll('\\', '/'));
    for (const forbidden of [
      'packages/core/agent.ts',
      'packages/tools/registry.ts',
      'packages/storage/sqlite.ts',
    ])
      assert.equal(
        inputs.includes(forbidden),
        false,
        `${entry} must be independent of ${forbidden}`,
      );
    assert.equal(
      inputs.some((name) => name.includes('node_modules/ajv')),
      false,
    );
  }
});

test('shared contracts cannot import implementation packages, including type-only imports', async () => {
  const root = new URL('../packages/protocol/', import.meta.url);
  for (const name of [
    'plans.ts',
    'session-lease.ts',
    'permissions.ts',
    'tool-hooks.ts',
    'tool-pipeline.ts',
    'failure.ts',
  ]) {
    const source = ts.createSourceFile(
      name,
      await readFile(new URL(name, root), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const dependency = specifier.text;
      assert.ok(
        dependency.startsWith('node:') ||
          (dependency.startsWith('.') && new URL(dependency, root).href.startsWith(root.href)),
        `${name} must not depend on implementation package ${dependency}`,
      );
    }
  }
});
