import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  dictionaryEntries,
  format,
  hasTranslation,
  setLocale,
  t as translate,
} from '../apps/desktop/i18n.ts';
import { tempRoot } from './temp-fixture.ts';

/**
 * The copy migrator is a migration tool, so the test is about the two things that make it safe to run over a real
 * component: it rewrites only what the dictionary already owns, and it refuses to guess about anything else.
 *
 * The fixtures live outside the repository, which is why every run passes `--import-specifier`: a temporary
 * directory on another drive has no relative path back to `apps/desktop/i18n.ts`, and inventing an absolute one
 * would produce an import that cannot resolve.
 */
const migrator = fileURLToPath(new URL('../scripts/migrate-ui-copy.mjs', import.meta.url));

async function fixture(
  t: test.TestContext,
  name: string,
  source: string,
): Promise<{ root: string; file: string }> {
  const root = await tempRoot(t, 'yuantu-copy-migrate-');
  const file = path.join(root, 'ui', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, 'utf8');
  return { root, file };
}

function run(root: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [migrator, '--import-specifier', '../i18n.ts', ...extra, root],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

test('a component is rewritten to dictionary keys, and the unmatched string is reported', async (t) => {
  const { root, file } = await fixture(
    t,
    'Panel.tsx',
    [
      'export function Panel({ name }: { name: string }) {',
      '  const label = `正在执行 ${name}`;',
      '  return (',
      '    <div aria-label="搜索会话">',
      '      <h1>新建会话</h1>',
      '      <p>{label}</p>',
      '      <p>未出现在字典里的中文</p>',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  const result = run(root, '--write');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no dictionary entry: 未出现在字典里的中文/);
  const output = await readFile(file, 'utf8');
  assert.match(output, /^import \{ t \} from '\.\.\/i18n\.ts';$/m);
  assert.match(output, /aria-label=\{t\('ui\.searchSessions'\)\}/);
  assert.match(output, /<h1>\{t\('ui\.newSession'\)\}<\/h1>/);
  assert.match(output, /const label = t\('ui\.runningTool', \{ name \}\);/);
  assert.match(output, /未出现在字典里的中文/);
  for (const match of output.matchAll(/t\('([^']+)'/g))
    assert.ok(hasTranslation(match[1]!), `${match[1]} is not a dictionary key`);
});

test('a plain module string is rewritten too, with the import added once', async (t) => {
  const { root, file } = await fixture(
    t,
    'labels.ts',
    "export const label = '新建会话';\nexport const other = '设置';\n",
  );
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = await readFile(file, 'utf8');
  assert.equal(output.match(/from '\.\.\/i18n\.ts'/g)?.length, 1);
  assert.match(output, /export const label = t\('ui\.newSession'\);/);
  assert.match(output, /export const other = t\('ui\.settings'\);/);
});

test('a dry run reports the rewrite without touching the file', async (t) => {
  const source = 'export const panel = <h1>新建会话</h1>;\n';
  const { root, file } = await fixture(t, 'Panel.tsx', source);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would rewrite 1 literal\(s\)/);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('a tree with nothing to rewrite is left alone', async (t) => {
  const source = 'export const value = 1;\n';
  const { root, file } = await fixture(t, 'plain.ts', source);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would rewrite 0 literal\(s\)/);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('a string the dictionary does not own is reported and left unchanged', async (t) => {
  const source = "export const label = '未出现在字典里的中文';\n";
  const { root, file } = await fixture(t, 'plain.ts', source);
  const result = run(root, '--write');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no dictionary entry/);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('a Chinese string with two keys is a collision, not a guess', async (t) => {
  const keys = new Map<string, string[]>();
  for (const [key, zh] of dictionaryEntries()) keys.set(zh, [...(keys.get(zh) ?? []), key]);
  const duplicate = [...keys].find(([, owned]) => owned.length > 1);
  if (!duplicate) {
    t.skip('the dictionary has no Chinese string with two keys to exercise collisions');
    return;
  }
  const [zh] = duplicate;
  const source = `export const label = ${JSON.stringify(zh)};\n`;
  const { root, file } = await fixture(t, 'plain.ts', source);
  const result = run(root, '--write');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /collision, left alone/);
  assert.equal(await readFile(file, 'utf8'), source);
});

/**
 * The legacy walker's dynamic lines used to carry their English as a literal beside the pattern. Each one now reads
 * the same dictionary the React UI reads, which is what the migration needs: one sentence, one owner. These are the
 * exact strings the walker's patterns produce, asserted here so a dictionary edit cannot silently change them.
 */
test('the legacy dynamic lines read their English from the dictionary', async (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('en-US');
  assert.equal(translate('mcp.title'), 'MCP Services');
  assert.equal(format(translate('ui.sessionActionsFor'), { name: 'abc' }), 'Session actions: abc');
  assert.equal(format(translate('ui.sessionShort'), { id: 'abc123' }), 'Session abc123');
  assert.equal(
    format(translate('ui.projectResources'), { instructions: '3', skills: '2', extensions: '1' }),
    'Project rules 3 · Skills 2 · Extensions 1',
  );
  assert.equal(
    format(translate('ui.sessionChanges'), { count: '4' }),
    'Session changes · 4 file operations',
  );
  assert.equal(format(translate('ui.runningTool'), { name: 'npm test' }), 'Running npm test');
  assert.equal(translate('ui.currentWorkspacePrefix'), 'Current workspace: ');
  assert.equal(translate('ui.disabled'), 'Disabled');
});
