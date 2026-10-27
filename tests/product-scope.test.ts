import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PRODUCT_SCOPE } from '../packages/protocol/product-scope.ts';
import { projectRoot } from './process-fixture.ts';
import * as workspaceRouting from '../apps/desktop/workspace-routing.ts';

test('removed management surfaces stay absent from the preload bridge even with legacy flags enabled', () => {
  const source = readFileSync(path.join(projectRoot, 'apps/desktop/preload.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const enabled of [false, true]) {
    let exposed: Record<string, (...args: unknown[]) => unknown> = {};
    const calls: unknown[][] = [];
    runInNewContext(compiled, {
      exports: {},
      require: (name: string) => {
        if (name.endsWith('/workspace-routing.ts')) return workspaceRouting;
        if (name.endsWith('/product-scope.ts'))
          return { PRODUCT_SCOPE: { ...PRODUCT_SCOPE, mcpManagement: enabled, backups: enabled } };
        // The bridge keeps a snapshot mirror; these tests are about which members it exposes, not about the
        // merge, so an inert mirror is enough. Everything else must still be Electron.
        if (name.endsWith('/snapshot-patch.ts'))
          return {
            SnapshotMirror: class {
              apply() {
                return { state: {}, changed: [] };
              }
            },
          };
        assert.equal(name, 'electron');
        return {
          contextBridge: {
            exposeInMainWorld: (name: string, bridge: typeof exposed) => {
              assert.equal(name, 'yuantu');
              exposed = bridge;
            },
          },
          ipcRenderer: { invoke: (...args: unknown[]) => calls.push(args), on: () => {} },
        };
      },
    });
    assert.equal(
      Object.hasOwn(exposed, 'backups'),
      false,
      'backup management is not a desktop API',
    );
    assert.equal(Object.hasOwn(exposed, 'mcp'), false, 'MCP configuration is not a desktop API');
    assert.deepEqual(calls, []);
  }
});

test('the removed SDK package subpath stays unexported', () => {
  assert.throws(() => import.meta.resolve('yuantu-agent/sdk'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});
