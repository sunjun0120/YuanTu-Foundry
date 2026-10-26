import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { rendererBuildOptions } from '../scripts/desktop-renderer-options.mjs';
import { projectRoot } from './process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

/**
 * The React toolchain is configuration, and configuration nobody checks is configuration that drifts.
 *
 * These assertions are the difference between "we intended to check .tsx" and "tsx is checked": the typecheck
 * project owns the extension, the tsc build leaves the React layer to esbuild, ESLint knows about hooks, and the
 * renderer build really does compile an automatic-runtime component and emit the Mantine stylesheet locally. The
 * fixtures are temporary trees so the tests exercise the same esbuild options the product build uses.
 */
interface TsConfig {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
}

async function readTsConfig(file: string): Promise<TsConfig> {
  return JSON.parse(await readFile(path.join(projectRoot, file), 'utf8')) as TsConfig;
}

test('the typecheck project owns .tsx and compiles it with the automatic runtime', async () => {
  const tsconfig = await readTsConfig('tsconfig.json');
  assert.equal(tsconfig.compilerOptions?.jsx, 'react-jsx');
  assert.ok(tsconfig.include?.includes('apps/**/*.tsx'), 'apps/**/*.tsx must be type-checked');
});

test('the tsc build leaves the React UI and its entry to esbuild', async () => {
  const buildConfig = await readTsConfig('tsconfig.build.json');
  const exclude = new Set(buildConfig.exclude ?? []);
  for (const entry of ['apps/desktop/ui', 'apps/desktop/renderer.ts'])
    assert.ok(exclude.has(entry), `${entry} must be excluded from the tsc build`);
});

test('the bridge globals stay in the tsc build so the plain renderer modules keep Window.yuantu', async () => {
  // Excluding the declaration would drop `window.yuantu` from every `setup*` module: a global declared in an
  // excluded module is invisible to the rest of the program.
  const buildConfig = await readTsConfig('tsconfig.build.json');
  assert.ok(
    !(buildConfig.exclude ?? []).includes('apps/desktop/renderer-globals.d.ts'),
    'the globals declaration must stay inside the tsc build',
  );
});

test('eslint covers the React UI and enables the hooks rules there', async () => {
  const source = await readFile(path.join(projectRoot, 'eslint.config.mjs'), 'utf8');
  assert.match(source, /apps\/\*\*\/\*\.tsx/);
  assert.match(source, /react-hooks\/rules-of-hooks/);
  assert.match(source, /react-hooks\/exhaustive-deps/);
});

test('esbuild compiles a TSX component with the automatic runtime and a production NODE_ENV', async (t) => {
  const root = await tempRoot(t, 'yuantu-tsx-build-');
  const entry = path.join(root, 'entry.tsx');
  await writeFile(
    entry,
    [
      "import { useState } from 'react';",
      'export const mode = process.env.NODE_ENV;',
      'export function Counter() {',
      '  const [count, setCount] = useState(0);',
      '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
      '}',
      '',
    ].join('\n'),
  );
  const result = await build(
    rendererBuildOptions({
      entryPoints: [entry],
      outfile: path.join(root, 'out.js'),
      write: false,
      format: 'esm',
      sourcemap: false,
      external: ['react', 'react/jsx-runtime'],
    }),
  );
  const js = (result.outputFiles ?? []).find((file) => file.path.endsWith('.js'))?.text ?? '';
  assert.match(js, /from "react\/jsx-runtime"/);
  assert.match(js, /"production"/);
  assert.doesNotMatch(js, /process\.env\.NODE_ENV/);
});

test('the renderer build emits the Mantine stylesheet locally', async (t) => {
  const root = await tempRoot(t, 'yuantu-mantine-css-');
  const entry = path.join(root, 'entry.tsx');
  await writeFile(
    entry,
    "import '@mantine/core/styles.css';\nexport const Panel = () => <div>panel</div>;\n",
  );
  const result = await build(
    rendererBuildOptions({
      entryPoints: [entry],
      outfile: path.join(root, 'out.js'),
      write: false,
      external: ['react', 'react/jsx-runtime'],
      nodePaths: [path.join(projectRoot, 'node_modules')],
    }),
  );
  const css = (result.outputFiles ?? []).find((file) => file.path.endsWith('.css'));
  assert.ok(css, 'esbuild should emit out.css for the Mantine stylesheet import');
  assert.ok(css.text.length > 10_000, 'the Mantine stylesheet should be bundled locally');
  assert.match(css.text, /--mantine/);
});
