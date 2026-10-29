import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPaths } from '../apps/desktop/install-paths.ts';
import { tempRoot } from './temp-fixture.ts';

const require = createRequire(import.meta.url);
const script = new URL('../scripts/prepare-macos-package.mjs', import.meta.url);
const config = require('../electron-builder.config.cjs');

test('bundled macOS Node rejects dynamic libraries outside Apple system directories', async () => {
  const { assertMacRuntimeDependencies } = await import(script.href);
  const listing = (library: string) =>
    `/runtime/node:\n\t${library} (compatibility version 1.0.0, current version 1.0.0)\n`;
  for (const library of [
    '/usr/lib/libSystem.B.dylib',
    '/System/Library/Frameworks/Security.framework/Versions/A/Security',
  ])
    assert.doesNotThrow(() => assertMacRuntimeDependencies(listing(library)));
  for (const library of [
    '/opt/homebrew/opt/icu4c/lib/libicuuc.dylib',
    '/usr/local/lib/libcrypto.dylib',
    '@rpath/libicuuc.dylib',
    '/usr/lib/../../opt/dependency.dylib',
  ])
    assert.throws(() => assertMacRuntimeDependencies(listing(library)), /external dynamic library/);
  assert.throws(() => assertMacRuntimeDependencies('not an executable'), /dependency listing/);
});

test('installed desktop resolves standalone runtime and Host artifacts for both supported platforms', () => {
  const resourcesPath = path.resolve('安装目录/YuanTu Agent.app/Contents/Resources');
  for (const [platform, filename] of [
    ['win32', 'node.exe'],
    ['darwin', 'node'],
  ] as const) {
    const result = desktopPaths({
      packaged: true,
      platform,
      resourcesPath,
      mainDirectory: path.join(resourcesPath, 'app/dist/desktop'),
      userData: path.resolve('用户数据'),
      cwd: path.resolve('.'),
      env: { YUANTU_NODE_PATH: path.resolve('external-node') },
      args: [],
    });
    assert.equal(result.nodePath, path.join(resourcesPath, 'runtime', filename));
    assert.equal(result.hostPath, path.join(resourcesPath, 'app/dist/apps/agent-host/main.js'));
  }
});

test('macOS targets include both distribution formats and explicitly sign the bundled runtime', async () => {
  assert.ok(config.mac, 'macOS packaging is configured');
  assert.deepEqual(config.mac.target, ['dmg', 'zip']);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.ok(config.mac.binaries.includes('Contents/Resources/runtime/node'));
  assert.equal(
    config.mac.identity,
    undefined,
    'signing identity is supplied by the build environment',
  );
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  await validateConfiguration(config, { isEnabled: false });
});

test('macOS runtime preflight rejects incompatible hosts, Node versions and architecture targets', async () => {
  const { assertMacRuntime } = await import(script.href);
  const host = { platform: 'darwin', arch: 'arm64', nodeVersion: '24.7.0' };
  assert.doesNotThrow(() => assertMacRuntime(host, 'arm64'));
  assert.doesNotThrow(() => assertMacRuntime({ ...host, arch: 'x64' }, 'x64'));
  assert.throws(() => assertMacRuntime({ ...host, platform: 'win32' }, 'arm64'), /macOS/);
  assert.throws(() => assertMacRuntime(host, 'x64'), /architecture/);
  assert.throws(() => assertMacRuntime(host, 'universal'), /architecture/);
  assert.throws(
    () => assertMacRuntime({ ...host, nodeVersion: '23.9.0' }, 'arm64'),
    /Node.js >=24/,
  );
  assert.throws(
    () => assertMacRuntime({ ...host, nodeVersion: 'invalid' }, 'arm64'),
    /Node.js >=24/,
  );
  assert.throws(
    () => assertMacRuntime({ ...host, electronVersion: '43.0.0' }, 'arm64'),
    /standalone Node/,
  );
});

test(
  'macOS preparation rejects non-macOS before writing or fetching any runtime',
  { skip: process.platform === 'darwin' && 'asserts the non-macOS failure path' },
  async (t) => {
    const directory = await tempRoot(t, 'yuantu-macos-preflight-');
    const child = spawnSync(process.execPath, [fileURLToPath(script)], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /macOS/);
    assert.deepEqual(await readdir(directory), []);
  },
);

test('macOS packaging rejects a stale platform, target architecture or altered runtime', async (t) => {
  const { validateMacRuntime } = await import(script.href);
  const directory = await tempRoot(t, 'yuantu-macos-manifest-');
  const node = Buffer.from('standalone Node test fixture');
  const license = 'Node.js is licensed for use as follows:\nfixture license';
  const manifest = {
    nodeVersion: '24.7.0',
    platform: 'darwin',
    architecture: 'arm64',
    sha256: createHash('sha256').update(node).digest('hex'),
    licenseUrl: 'https://raw.githubusercontent.com/nodejs/node/v24.7.0/LICENSE',
    licenseSha256: createHash('sha256').update(license).digest('hex'),
  };
  await writeFile(path.join(directory, 'node'), node, { mode: 0o755 });
  await writeFile(path.join(directory, 'LICENSE.node'), license);
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(manifest));
  await validateMacRuntime(directory, 'arm64');
  await assert.rejects(validateMacRuntime(directory, 'x64'), /architecture/);
  await writeFile(
    path.join(directory, 'runtime.json'),
    JSON.stringify({ ...manifest, platform: 'win32' }),
  );
  await assert.rejects(validateMacRuntime(directory, 'arm64'), /macOS/);
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'node'), 'changed binary');
  await assert.rejects(validateMacRuntime(directory, 'arm64'), /hash/);
  await writeFile(path.join(directory, 'node'), node);
  await writeFile(path.join(directory, 'LICENSE.node'), 'changed license');
  await assert.rejects(validateMacRuntime(directory, 'arm64'), /license/i);
});

test('macOS package commands perform preflight first and bind explicit targets to matching runtimes', async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const arch of ['arm64', 'x64']) {
    for (const suffix of ['', ':dir']) {
      const command = scripts[`package:macos:${arch}${suffix}`];
      assert.ok(command, `package:macos:${arch}${suffix} exists`);
      assert.ok(command.startsWith(`node scripts/prepare-macos-package.mjs --arch=${arch} && `));
      assert.ok(command.includes(`--mac --${arch}`));
      assert.equal(command.includes('--dir'), suffix === ':dir');
    }
  }
  assert.ok(scripts['package:macos'].startsWith('node scripts/prepare-macos-package.mjs && '));
  assert.ok(scripts['package:macos:dir'].endsWith('--mac --dir'));
});

test(
  'builder prepack hook prepares Windows runtime and temporary storage and rejects macOS builds on a foreign host',
  { skip: process.platform === 'darwin' && 'asserts the non-macOS failure path' },
  async (t) => {
    assert.equal(typeof config.beforePack, 'function');
    /**
     * The Windows branch validates the staged runtime that `scripts/prepare-windows-package.mjs`
     * publishes at the repository-relative `.scratch/packaging/runtime`, so the hook is driven from a
     * fixture staged for this test rather than from whatever a previous packaging run left behind.
     */
    const root = await tempRoot(t, 'yuantu-prepack-');
    const runtime = path.join(root, '.scratch/packaging/runtime');
    await mkdir(runtime, { recursive: true });
    const node = Buffer.from('staged runtime fixture');
    const license = 'Node.js is licensed for use as follows:\nfixture license';
    await writeFile(path.join(runtime, 'node.exe'), node);
    await writeFile(path.join(runtime, 'LICENSE.node'), license);
    await writeFile(
      path.join(runtime, 'runtime.json'),
      JSON.stringify({
        selection: 'explicit-or-host',
        profile: 'upstream-unqualified',
        sha256: createHash('sha256').update(node).digest('hex'),
        licenseSha256: createHash('sha256').update(license).digest('hex'),
      }),
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { writeFile, readFile, copyFile } from 'node:fs/promises';
      import { execFileSync } from 'node:child_process';
      import path from 'node:path';
      const config = createRequire(${JSON.stringify(import.meta.url)})('../electron-builder.config.cjs');
      if (process.platform === 'win32') {
        // By absolute path: a PATH with Git's usr/bin ahead of System32 resolves 'whoami.exe' to coreutils' whoami.
        const identity = execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding:'utf8',windowsHide:true});
        const sid = identity.match(/S-1-5-21-[0-9-]+/)?.[0];
        assert.ok(sid);
        execFileSync('icacls.exe', [process.cwd(), '/grant', '*' + sid + ':(OI)(CI)F'], {windowsHide:true});
        execFileSync('icacls.exe', [process.cwd(), '/setintegritylevel', '(OI)(CI)L'], {windowsHide:true});
      }
      const appOutDir = path.join(process.cwd(), 'release', 'win-unpacked');
      await config.beforePack({ electronPlatformName: 'win32', arch: 1, appOutDir });
      if (process.platform === 'win32') {
        const executable = path.join(appOutDir, 'identity.exe');
        await copyFile(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), executable);
        const groups = execFileSync(executable, ['/groups', '/fo', 'csv', '/nh'], {encoding:'utf8',windowsHide:true});
        assert.match(groups, /S-1-16-8192/, 'prepack must protect output from an inherited Low label');
        assert.equal(process.env.TEMP, process.env.TMP);
        const relative = path.relative(process.cwd(), process.env.TEMP);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        const file = path.join(process.env.TEMP, 'nsis-write-probe.tmp');
        await writeFile(file, 'NSIS temporary file');
        assert.equal(await readFile(file, 'utf8'), 'NSIS temporary file');
      }
      await assert.rejects(config.beforePack({ electronPlatformName: 'darwin', arch: 3 }), /macOS/);
    `,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, TEMP: path.join(root, 'missing'), TMP: path.join(root, 'missing') },
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
  },
);
