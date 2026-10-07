import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { desktopPaths } from '../apps/desktop/install-paths.ts';

test('installed desktop uses its bundled Node and stable profile workspace under paths with spaces and Chinese', () => {
  const resources = path.resolve('C:/安装目录/YuanTu Agent/resources');
  const profile = path.resolve('C:/用户数据/YuanTu Agent');
  const result = desktopPaths({
    packaged: true,
    resourcesPath: resources,
    mainDirectory: path.join(resources, 'app/dist/desktop'),
    userData: profile,
    cwd: 'C:/Windows/System32',
    env: {},
    args: [],
  });
  assert.equal(result.nodePath, path.join(resources, 'runtime/node.exe'));
  assert.equal(result.workspace, path.join(profile, 'workspace'));
  assert.equal(result.hostPath, path.join(resources, 'app/dist/apps/agent-host/main.js'));
});

test('development launch preserves explicit Node and workspace; packaged launch accepts a workspace argument', () => {
  const directory = path.resolve('dist/desktop');
  const node = path.resolve('node.exe');
  const workspace = path.resolve('work space');
  const options = {
    resourcesPath: path.resolve('resources'),
    mainDirectory: directory,
    userData: path.resolve('profile'),
    cwd: path.resolve('.'),
    env: { YUANTU_NODE_PATH: node, YUANTU_WORKSPACE: workspace },
    args: [],
  };
  assert.equal(desktopPaths({ ...options, packaged: false }).nodePath, node);
  assert.equal(desktopPaths({ ...options, packaged: false }).workspace, workspace);
  assert.equal(
    desktopPaths({ ...options, packaged: true, args: [`--workspace=${workspace}`] }).workspace,
    workspace,
  );
  assert.throws(() => desktopPaths({ ...options, packaged: false, env: {} }), /Node/i);
});
