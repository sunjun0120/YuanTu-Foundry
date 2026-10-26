import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot } from './temp-fixture.ts';

/**
 * The TSX boundary is a rule about files nobody has written yet.
 *
 * Node's test runner strips types from `.ts` but cannot load `.tsx`, so a plain `.ts` module that reaches a component
 * — directly, through another `.ts`, or through a type-only import — turns a test that imports it into a syntax
 * error at run time. Only two places may reach a component: the `renderer.ts` entry, which mounts them, and the TSX
 * files under `ui/`, which compose each other. Everything else is a mistake this gate has to name by file.
 */
const gate = fileURLToPath(new URL('../scripts/check-layers.mjs', import.meta.url));

async function tree(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await tempRoot(t, 'yuantu-layers-');
  for (const directory of ['packages', 'apps'])
    await mkdir(path.join(root, directory), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body, 'utf8');
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [gate], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('a .ts module that imports a component is rejected', async (t) => {
  const root = await tree(t, {
    'apps/desktop/renderer-widget.ts': "export { Button } from './ui/Button.tsx';\n",
    'apps/desktop/ui/Button.tsx': 'export const Button = () => null;\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /renderer-widget\.ts/);
  assert.match(result.stderr, /\.tsx/);
});

test('renderer.ts is the one .ts entry allowed to mount components', async (t) => {
  const root = await tree(t, {
    'apps/desktop/renderer.ts': "export { Button } from './ui/Button.tsx';\n",
    'apps/desktop/ui/Button.tsx': 'export const Button = () => null;\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a component may compose components and import plain modules', async (t) => {
  const root = await tree(t, {
    'apps/desktop/renderer.ts': "export { Button } from './ui/Button.tsx';\n",
    'apps/desktop/ui/Button.tsx':
      "import { theme } from './theme.ts';\nimport { Icon } from './Icon.tsx';\nexport const Button = () => [theme, Icon];\n",
    'apps/desktop/ui/Icon.tsx': 'export const Icon = () => null;\n',
    'apps/desktop/ui/theme.ts': 'export const theme = {};\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the boundary is transitive: a plain module two hops away still counts', async (t) => {
  const root = await tree(t, {
    'apps/desktop/helper.ts': "export { middle } from './middle.ts';\n",
    'apps/desktop/middle.ts': "export { Button as middle } from './ui/Button.tsx';\n",
    'apps/desktop/ui/Button.tsx': 'export const Button = () => null;\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /helper\.ts/);
});

test('a type-only import is still a dependency on a component', async (t) => {
  const root = await tree(t, {
    'apps/desktop/helper.ts':
      "export type { Props } from './ui/Button.tsx';\nexport const value = 1;\n",
    'apps/desktop/ui/Button.tsx': 'export interface Props {\n  label: string;\n}\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('a value import keeps the existing layer order when the target is a component', async (t) => {
  const root = await tree(t, {
    'packages/protocol/badge.tsx': "export { core } from '../core/value.ts';\n",
    'packages/core/value.ts': 'export const core = 1;\n',
  });
  const result = run(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /goes against the layer order/);
});
