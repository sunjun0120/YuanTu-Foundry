import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './process-fixture.ts';

test('retired desktop styles stay within the migration budget', async () => {
  const sheets = [
    'styles.css',
    'styles-subagents.css',
    'styles-panels.css',
    'layout.css',
    'layout-surfaces.css',
    'layout-workspace.css',
  ];
  const sources = await Promise.all(
    sheets.map((name) => readFile(path.join(projectRoot, 'apps/desktop', name), 'utf8')),
  );
  const lines = sources.reduce((sum, source) => sum + source.trimEnd().split('\n').length, 0);
  assert.ok(lines <= 1200, `legacy CSS ${lines} lines exceeds the 1200-line retirement budget`);
  assert.equal(sources.join('\n').includes('!important'), false);
});

test('React component styling does not depend on migrated element ids', async () => {
  const css = await readFile(path.join(projectRoot, 'apps/desktop/ui/styles.css'), 'utf8');
  const selectors = [
    ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[{}])\s*([^{}]+)\{/g),
  ].map((match) => match[1]!);
  assert.deepEqual(
    selectors.filter((selector) => /#[a-zA-Z][\w-]*/.test(selector)),
    [],
  );
});
