import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hasTranslation } from '../apps/desktop/i18n.ts';
import { withoutComments } from '../scripts/i18n-gate.mjs';
import { projectRoot } from './process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

/**
 * The React UI's copy rule, checked over the tree rather than trusted.
 *
 * The i18n gate (which `i18n:check` runs) answers a nearby question: it reports Chinese in modules a person reads.
 * This test answers the other half — a key the dictionary does not own renders as the key itself, which the gate
 * cannot see because there is no Chinese to find. Both halves are checked on a fixture first, so a checker that
 * silently matches nothing cannot pass by doing nothing.
 */
interface Problem {
  file: string;
  line: number;
  kind: 'copy' | 'key';
  text: string;
}
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

async function modules(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await modules(full)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every Chinese literal and every unknown `t()` key under one `ui/` directory. */
async function check(dir: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const file of await modules(dir)) {
    const lines = withoutComments(await readFile(file, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (HAN.test(line)) problems.push({ file, line: index + 1, kind: 'copy', text: line.trim() });
      for (const match of line.matchAll(/(?:t|translate)\(\s*'([^']+)'/g))
        if (!hasTranslation(match[1]!))
          problems.push({ file, line: index + 1, kind: 'key', text: match[1]! });
    }
  }
  return problems;
}

test('the checker reports Chinese copy and unknown keys on a fixture', async (t) => {
  const root = await tempRoot(t, 'yuantu-ui-copy-');
  const dir = path.join(root, 'ui');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'Panel.tsx'),
    [
      '// 中文注释不是文案',
      'export const panel = <h1>新建会话</h1>;',
      "export const label = t('ui.noSuchKey');",
      '',
    ].join('\n'),
    'utf8',
  );
  const problems = await check(dir);
  assert.ok(
    problems.some((problem) => problem.kind === 'copy' && problem.line === 2),
    'the JSX copy should be reported',
  );
  assert.ok(
    problems.some((problem) => problem.kind === 'key' && problem.text === 'ui.noSuchKey'),
    'the unknown key should be reported',
  );
  assert.ok(!problems.some((problem) => problem.line === 1), 'a comment is not copy');
});

test('the React UI renders its copy through the dictionary', async () => {
  const problems = await check(path.join(projectRoot, 'apps/desktop/ui'));
  assert.deepEqual(problems, []);
});
