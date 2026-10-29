import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { EVAL_TESTS } from './test-execution-policy.ts';

export interface TestSelection {
  tests: string[];
  full: boolean;
  reason: string;
}

const source = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const unit = /^tests\/[^/]+\.test\.ts$/;
const normalize = (file: string) => file.replaceAll('\\', '/').replace(/^\.\//, '');
const exec = promisify(execFile);

export function requiresDesktop(changed: string[]): boolean {
  return changed.some((input) => {
    const file = normalize(input);
    return file.startsWith('apps/desktop/') || (file.startsWith('tests/') && !unit.test(file));
  });
}

export async function getChangedFiles(root: string, base = 'HEAD'): Promise<string[]> {
  const options = { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  const { stdout: commit } = await exec(
    'git',
    ['rev-parse', '--verify', `${base}^{commit}`],
    options,
  );
  const results = await Promise.all([
    exec('git', ['diff', '--name-only', '-z', commit.trim(), '--'], options),
    exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], options),
  ]);
  return [...new Set(results.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))].sort();
}

async function sources(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const result: string[] = [];
  for (const entry of entries) {
    if (['dist', 'node_modules', '.scratch'].includes(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await sources(root, file)));
    else if (source.test(file)) result.push(file);
  }
  return result;
}

/** Conservative development selection, never a replacement for the full CI gate. */
export async function selectTests(root: string, changed: string[]): Promise<TestSelection> {
  const files = (
    await Promise.all(['tests', 'packages', 'apps', 'scripts'].map((dir) => sources(root, dir)))
  ).flat();
  // The grading suites are not part of the suite this selector reasons about; `npm run test:eval`
  // owns them, and `npm test` does not discover them either.
  const graded = new Set<string>(EVAL_TESTS);
  const tests = files.filter((file) => unit.test(file) && !graded.has(file)).sort();
  const known = new Set(files);
  const full = (reason: string): TestSelection => ({ tests, full: true, reason });
  const changes = [...new Set(changed.map(normalize))];
  const code = changes.filter(
    (file) => !(file === 'README.md' || file === 'LICENSE' || /^docs\/.*\.md$/.test(file)),
  );
  if (!code.length)
    return { tests: [], full: false, reason: changes.length ? 'Documentation only' : 'No changes' };
  /**
   * Changes that still mean "run everything".
   *
   * The packages below are the runtime's shared contracts and its most widely imported modules; a
   * change to one of them reaches code the import graph cannot name, so they keep the whole suite.
   * The harness and shared fixtures are the same idea one level up: they decide how every other
   * file runs, or are spawned by name from tests that never import them.
   *
   * `apps/` is deliberately absent. Its entry points are spawned by subprocess, and the selector
   * already follows the path literals those spawns use, so a change lands on the tests that start
   * it — measured here as 48 files for `apps/agent-host/handlers/*` and 4 for `apps/desktop/ui/*`.
   * A desktop change also keeps its Electron smoke gate, which `check-changed` runs separately
   * because those files are not `.test.ts` and so are never part of this selection.
   */
  const contract = /^packages\/(?:core|protocol|storage|tools|client|carrier|sdk)\//;
  const sharedFixture = (file: string) => file.startsWith('tests/') && !unit.test(file);
  if (
    code.some(
      (file) =>
        contract.test(file) ||
        sharedFixture(file) ||
        // The harness decides how every other file runs, so it is never a local change.
        file.startsWith('scripts/'),
    )
  )
    return full('Shared contract, test harness, validation script or shared fixture changed');
  if (code.some((file) => !source.test(file) || !known.has(file))) {
    return full('Configuration, fixture, deleted source or unknown file changed');
  }
  const reverse = new Map<string, Set<string>>();
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const literals = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) literals.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const literal of literals) {
      if (!(literal.startsWith('.') || /^(?:packages|apps|tests|scripts)\//.test(literal)))
        continue;
      const absolute = literal.startsWith('.')
        ? path.resolve(root, path.dirname(file), literal)
        : path.resolve(root, literal);
      const relative = normalize(path.relative(root, absolute));
      const candidates = [
        relative,
        relative.replace(/\.js$/, '.ts'),
        `${relative}.ts`,
        `${relative}/index.ts`,
      ];
      for (const dependency of candidates) {
        if (!known.has(dependency)) continue;
        const consumers = reverse.get(dependency) ?? new Set<string>();
        consumers.add(file);
        reverse.set(dependency, consumers);
      }
    }
  }
  const selected = new Set<string>();
  for (const change of code) {
    // New files without a known consumer must not silently get zero tests.
    if (!(await stat(path.join(root, change)).catch(() => undefined)))
      return full(`Deleted source: ${change}`);
    const seen = new Set<string>();
    const queue = [change];
    const affected = new Set<string>();
    for (const next of queue) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (unit.test(next)) affected.add(next);
      queue.push(...(reverse.get(next) ?? []));
    }
    if (!affected.size) return full(`No reliable test mapping: ${change}`);
    // Grading suites answer a milestone, not an edit: `npm run test:eval` owns them.
    for (const file of affected) if (!graded.has(file)) selected.add(file);
  }
  if (!selected.size)
    return {
      tests: [],
      full: false,
      reason: 'Only grading suites are affected; run npm run test:eval',
    };
  return {
    tests: [...selected].sort(),
    full: false,
    reason: 'Transitive imports and literal worker paths',
  };
}
