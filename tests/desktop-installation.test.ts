import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopPaths } from '../apps/desktop/install-paths.ts';
import { tempRoot } from './temp-fixture.ts';

test('installed desktop uses its bundled Node and stable profile workspace under paths with spaces and Chinese', () => {
  const resources = path.resolve('C:/安装目录/YuanTu Agent/resources');
  const profile = path.resolve('C:/用户数据/YuanTu Agent');
  const result = desktopPaths({
    packaged: true,
    platform: 'win32',
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

test('a development launch that skipped the launcher resolves the Host Node from npm or PATH, and refuses when neither exists', async (t) => {
  const root = await tempRoot(t, 'yuantu-development-node-');
  const options = {
    packaged: false,
    resourcesPath: path.join(root, 'resources'),
    mainDirectory: path.join(root, 'app/dist/desktop'),
    userData: path.join(root, 'profile'),
    cwd: root,
    args: [],
  };
  // `npm run` exports the Node it is running under, so any npm script reaches the Host without the launcher.
  const npmNode = path.join(root, 'npm-node');
  await writeFile(npmNode, '');
  assert.equal(desktopPaths({ ...options, env: { npm_node_execpath: npmNode } }).nodePath, npmNode);
  // An IDE run or a bare `electron dist/desktop/main.cjs` inherits PATH instead; the entry may end in a separator.
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const onPath = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  await writeFile(onPath, '');
  assert.equal(
    desktopPaths({ ...options, env: { PATH: `${bin}${path.delimiter}` } }).nodePath,
    onPath,
  );
  // Nothing to run the Host with: the failure names the Node requirement rather than spawning a missing binary.
  assert.throws(() => desktopPaths({ ...options, env: { PATH: root } }), /Node/);
  // A relative YUANTU_NODE_PATH is refused rather than silently replaced by the Node on PATH.
  assert.throws(
    () => desktopPaths({ ...options, env: { YUANTU_NODE_PATH: 'node', PATH: bin } }),
    /Node/,
  );
});

test('the single-file Host bundle is preferred when built, and the compiled entry is the fallback', async (t) => {
  const root = await tempRoot(t, 'yuantu-install-paths-');
  const options = {
    packaged: false,
    resourcesPath: path.join(root, 'resources'),
    mainDirectory: path.join(root, 'app/dist/desktop'),
    userData: path.join(root, 'profile'),
    cwd: root,
    env: { YUANTU_NODE_PATH: process.execPath },
    args: [],
  };
  const compiled = path.join(root, 'app/dist/apps/agent-host/main.js');
  const bundled = path.join(root, 'app/dist/packages/tools/host.bundle.js');
  // A checkout that only ran `tsc` has no bundle; the compiled entry is what starts.
  assert.equal(desktopPaths(options).hostPath, compiled);
  await mkdir(path.dirname(bundled), { recursive: true });
  await writeFile(bundled, '// one file\n');
  assert.equal(desktopPaths(options).hostPath, bundled);
});
