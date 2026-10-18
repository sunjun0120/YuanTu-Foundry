import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PRODUCT_SCOPE } from '../packages/protocol/product-scope.ts';
import { projectRoot } from './process-fixture.ts';

const PAUSED_BRIDGES = [
  { flag: 'backups', member: 'backups', channel: 'yuantu:backups', module: 'main-backups.ts' },
  { flag: 'mcpManagement', member: 'mcp', channel: 'yuantu:mcp', module: 'main-mcp.ts' },
] as const;

for (const { flag, member, channel, module } of PAUSED_BRIDGES)
  test(`paused ${member} is absent from the preload bridge and its IPC registration is scope guarded`, async () => {
    assert.equal(PRODUCT_SCOPE[flag], false);
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
          if (name.endsWith('/product-scope.ts'))
            return { PRODUCT_SCOPE: { ...PRODUCT_SCOPE, [flag]: enabled } };
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
            ipcRenderer: { invoke: (...args: unknown[]) => calls.push(args) },
          };
        },
      });
      assert.equal(Object.hasOwn(exposed, member), enabled);
      if (enabled) {
        await exposed[member]!({ type: 'get' });
        assert.deepEqual(calls, [[channel, { type: 'get' }]]);
      } else assert.deepEqual(calls, []);
    }
    const main = ts.createSourceFile(
      module,
      readFileSync(path.join(projectRoot, 'apps/desktop', module), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let registrations = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(main) === 'ipcMain.handle' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === channel
      ) {
        registrations++;
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor && !ts.isIfStatement(ancestor)) ancestor = ancestor.parent;
        assert.ok(ancestor && ts.isIfStatement(ancestor));
        assert.equal(ancestor.expression.getText(main), `PRODUCT_SCOPE.${flag}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(main);
    assert.equal(registrations, 1);
  });

test('the paused daily-backup scheduler is constructed only under its scope flag', () => {
  const main = ts.createSourceFile(
    'main-backups.ts',
    readFileSync(path.join(projectRoot, 'apps/desktop/main-backups.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let constructions = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(main) === 'DailyBackups') {
      constructions++;
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor && !ts.isIfStatement(ancestor)) ancestor = ancestor.parent;
      assert.ok(
        ancestor && ts.isIfStatement(ancestor),
        'the paused scheduler must be created inside its scope guard',
      );
      assert.equal(ancestor.expression.getText(main), 'PRODUCT_SCOPE.backups');
    }
    ts.forEachChild(node, visit);
  };
  visit(main);
  assert.equal(constructions, 1);
});

test('the removed SDK package subpath stays unexported', () => {
  assert.throws(() => import.meta.resolve('yuantu-agent/sdk'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});
