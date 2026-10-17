import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PRODUCT_SCOPE } from '../packages/protocol/product-scope.ts';
import { projectRoot } from './process-fixture.ts';

test('paused backups are absent from the preload bridge and their IPC registration is scope guarded', async () => {
  assert.equal(PRODUCT_SCOPE.backups, false);
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
          return { PRODUCT_SCOPE: { ...PRODUCT_SCOPE, backups: enabled } };
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
    assert.equal(Object.hasOwn(exposed, 'backups'), enabled);
    if (enabled) {
      await exposed.backups!({ type: 'get' });
      assert.deepEqual(calls, [['yuantu:backups', { type: 'get' }]]);
    } else assert.deepEqual(calls, []);
  }
  const main = ts.createSourceFile(
    'main.ts',
    readFileSync(path.join(projectRoot, 'apps/desktop/main.ts'), 'utf8'),
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
      node.arguments[0].text === 'yuantu:backups'
    ) {
      registrations++;
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor && !ts.isIfStatement(ancestor)) ancestor = ancestor.parent;
      assert.ok(ancestor && ts.isIfStatement(ancestor));
      assert.equal(ancestor.expression.getText(main), 'PRODUCT_SCOPE.backups');
    }
    ts.forEachChild(node, visit);
  };
  visit(main);
  assert.equal(registrations, 1);
});

for (const entry of ['apps/cli/main.ts', 'apps/web/main.ts', 'apps/agent-acp/main.ts']) {
  test(`${entry} refuses startup while its public entry is paused`, (t) => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'yuantu-paused-entry-'));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [path.join(projectRoot, entry), '--help'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /temporarily disabled in the desktop-only product/);
    assert.deepEqual(readdirSync(workspace), [], 'a paused entry must not create workspace state');
  });
}

test('the public SDK package subpath is not exported while paused', () => {
  assert.throws(() => import.meta.resolve('yuantu-agent/sdk'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});

test('the retained Web bridge refuses programmatic startup while paused', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'yuantu-paused-bridge-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { startBridge } = await import('../apps/web/main.ts');
  await assert.rejects(
    startBridge({ workspace, port: 0, token: 'paused-test', page: workspace }),
    /temporarily disabled in the desktop-only product/,
  );
  assert.deepEqual(readdirSync(workspace), []);
});
