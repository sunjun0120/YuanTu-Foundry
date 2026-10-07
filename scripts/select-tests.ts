import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';

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
  const tests = files.filter((file) => unit.test(file)).sort();
  const known = new Set(files);
  const full = (reason: string): TestSelection => ({ tests, full: true, reason });
  const changes = [...new Set(changed.map(normalize))];
  const code = changes.filter(
    (file) => !(file === 'README.md' || file === 'LICENSE' || /^docs\/.*\.md$/.test(file)),
  );
  if (!code.length)
    return { tests: [], full: false, reason: changes.length ? 'Documentation only' : 'No changes' };
  // Subprocess entry points, authorization, persistence and shared contracts have implicit consumers.
  if (
    code.some(
      (file) =>
        /^(?:apps\/|scripts\/|packages\/(?:core|protocol|storage|tools|client|carrier|sdk)\/)/.test(
          file,
        ) ||
        (file.startsWith('tests/') && !unit.test(file)),
    )
  ) {
    return full('Runtime entry point, validation script or shared critical module changed');
  }
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
    for (const file of affected) selected.add(file);
  }
  return {
    tests: [...selected].sort(),
    full: false,
    reason: 'Transitive imports and literal worker paths',
  };
}
