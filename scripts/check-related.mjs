import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

/**
 * Development subset for iterative edits: the tests that transitively import the files you changed.
 *
 * `scripts/select-tests.ts` deliberately answers a different question — "may I skip anything before CI?" — and
 * its answer is "no" for a shared module, which is right for a gate and useless for a reflex. This reuses the
 * same reverse-dependency graph (built the same way, from the string literals each file mentions) but walks it
 * for every changed file instead of deferring to the full suite, so `packages/core/agent.ts` selects the tests
 * that actually import it rather than all 165.
 *
 * It is a *development* tool: run the full suite once when the work is done, never instead of it.
 */
const root = process.cwd();
const source = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const unit = /^tests\/[^/]+\.test\.ts$/;
const normalize = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');

async function sources(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(
    () => [],
  );
  const result = [];
  for (const entry of entries) {
    if (['dist', 'node_modules', '.scratch'].includes(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await sources(file)));
    else if (source.test(file)) result.push(file);
  }
  return result;
}

async function changedFiles(base) {
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });
  const head = (await run(['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const tracked = await run(['diff', '--name-only', '-z', head, '--']);
  const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))].map(
    normalize,
  );
}

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD';
const explicit = args.filter((arg) => !arg.startsWith('--') && arg !== base);

const files = (
  await Promise.all(['tests', 'packages', 'apps', 'scripts'].map((dir) => sources(dir)))
).flat();
const known = new Set(files);
const tests = files.filter((file) => unit.test(file)).sort();

const reverse = new Map();
for (const file of files) {
  const text = await readFile(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const literals = new Set();
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const literal of literals) {
    if (!(literal.startsWith('.') || /^(?:packages|apps|tests|scripts)\//.test(literal))) continue;
    const absolute = literal.startsWith('.')
      ? path.resolve(root, path.dirname(file), literal)
      : path.resolve(root, literal);
    const relative = normalize(path.relative(root, absolute));
    for (const dependency of [
      relative,
      relative.replace(/\.js$/, '.ts'),
      `${relative}.ts`,
      `${relative}/index.ts`,
    ]) {
      if (!known.has(dependency)) continue;
      const consumers = reverse.get(dependency) ?? new Set();
      consumers.add(file);
      reverse.set(dependency, consumers);
    }
  }
}

const changed = explicit.length ? explicit.map(normalize) : await changedFiles(base);
const selected = new Set();
const unmapped = [];
for (const change of changed) {
  if (!(await stat(path.join(root, change)).catch(() => undefined))) continue;
  const seen = new Set();
  const queue = [change];
  const affected = new Set();
  while (queue.length) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (unit.test(next)) affected.add(next);
    for (const consumer of reverse.get(next) ?? []) queue.push(consumer);
  }
  if (!affected.size) unmapped.push(change);
  for (const file of affected) selected.add(file);
}

const chosen = [...selected].sort();
console.log(`changed: ${changed.length} file(s)`);
console.log(`selected: ${chosen.length} of ${tests.length} test files`);
if (unmapped.length)
  console.log(`no test imports (full suite still needed): ${unmapped.join(', ')}`);
if (process.argv.includes('--list')) for (const file of chosen) console.log(`  ${file}`);
if (process.argv.includes('--plan') || !chosen.length) process.exit(0);

const started = performance.now();
const child = spawn(
  process.execPath,
  ['scripts/run-tests.mjs', `--concurrency=${process.env.CHECK_CONCURRENCY ?? 4}`, ...chosen],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
child.on('close', (code) => {
  console.log(`subset finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = code ?? 1;
});
