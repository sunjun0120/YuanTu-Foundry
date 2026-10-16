/**
 * File-level import cycles, gated at zero.
 *
 * `§3.2` of the assessment counts *package pairs* that import each other in both directions and finds eight of
 * them. That number cannot answer the question a cycle actually poses, because the two directions of a package
 * pair may connect different files — and it points at the wrong repair, since most of those back-references are
 * pure type imports that the compiler erases and that nothing needs to change. Measured at file level over the
 * value imports, this repository has **zero** cycles: 792 value edges across 319 files, no strongly connected
 * component larger than one. So the gate is calibrated to what is true, and its job is to keep it true rather
 * than to demand a rewrite of coupling that is not there.
 *
 * What counts as an edge, and what deliberately does not:
 *
 * - `import { x } from './y.ts'`, `import Default from './y.ts'`, `import * as ns from './y.ts'`, bare
 *   `import './y.ts'`, and `export … from './y.ts'` are **value** edges.
 * - `import type { … }`, `import type X`, and a named import whose members are *all* marked `type` are excluded.
 *   They are erased before the module graph exists, so they cannot take part in an initialization cycle.
 * - Import type queries are excluded. Actual dynamic `import()` calls are reported separately, without adding
 *   them to this static graph. This gate does not claim to detect asynchronous initialization deadlocks.
 *
 * Only static cycles carry the hazard this gate exists for, and a gate that cries wolf gets deleted.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const SCANNED = ['apps', 'packages'];
const SKIPPED = new Set(['node_modules', 'dist']);

function typeOnly(statement) {
  if (ts.isImportEqualsDeclaration(statement)) return statement.isTypeOnly;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((item) => item.isTypeOnly)
    );
  }
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return (
    clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((item) => item.isTypeOnly)
  );
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (/\.(?:ts|mts|cts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const files = [];
for (const scanned of SCANNED) {
  try {
    files.push(...(await walk(path.join(root, scanned))));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const graph = new Map();
const unresolved = [];
const dynamicImports = [];
let excludedTypes = 0;
const scannedFiles = new Set(files);

const addEdge = (from, to) => {
  if (!graph.has(from)) graph.set(from, new Set());
  graph.get(from).add(to);
};

/** Resolve a relative specifier to a scanned file, or report why it could not be. */
const resolve = (fromFile, specifier) => {
  if (!specifier.startsWith('.')) return undefined;
  const target = path.resolve(path.dirname(fromFile), specifier);
  const relative = path.relative(root, target);
  return scannedFiles.has(target) ? relative : undefined;
};

for (const file of files) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : ts.isImportEqualsDeclaration(statement) &&
            ts.isExternalModuleReference(statement.moduleReference)
          ? statement.moduleReference.expression
          : undefined;
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      const specifier = moduleSpecifier.text;
      const target = resolve(file, specifier);
      if (target === undefined) {
        if (specifier.startsWith('.')) unresolved.push(`${relative} -> ${specifier}`);
        continue;
      }
      if (typeOnly(statement)) {
        excludedTypes++;
        continue;
      }
      addEdge(relative, target);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      dynamicImports.push(
        `${relative}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
      );
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

// Tarjan's algorithm, iteratively: a recursive version would be simpler and would overflow on a deep graph.
const nodes = new Set(files.map((file) => path.relative(root, file)));
for (const targets of graph.values()) for (const target of targets) nodes.add(target);
const index = new Map(),
  low = new Map(),
  onStack = new Set(),
  stack = [],
  cycles = [];
let counter = 0;
for (const start of nodes) {
  if (index.has(start)) continue;
  const work = [[start, 0]];
  while (work.length) {
    const frame = work[work.length - 1];
    const [node] = frame;
    if (frame[1] === 0) {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
    }
    const targets = [...(graph.get(node) ?? [])];
    let descended = false;
    for (let i = frame[1]; i < targets.length; i++) {
      const next = targets[i];
      if (!index.has(next)) {
        frame[1] = i + 1;
        work.push([next, 0]);
        descended = true;
        break;
      }
      if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (descended) continue;
    frame[1] = targets.length;
    if (low.get(node) === index.get(node)) {
      const component = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.sort());
    }
    work.pop();
    if (work.length) {
      const parent = work[work.length - 1][0];
      low.set(parent, Math.min(low.get(parent), low.get(node)));
    }
  }
}

const edges = [...graph.values()].reduce((total, targets) => total + targets.size, 0);
const problems = [];
for (const cycle of cycles.sort((a, b) => b.length - a.length)) {
  const trail = cycle
    .map((member) => {
      const targets = [...(graph.get(member) ?? [])].filter((target) => cycle.includes(target));
      return `${member} -> ${targets.join(', ')}`;
    })
    .join('; ');
  problems.push(`value-import cycle of ${cycle.length} file(s): ${trail}`);
}
for (const line of unresolved) problems.push(`relative specifier does not resolve: ${line}`);

if (problems.length) {
  console.error('cycles:check failed:\n' + problems.map((line) => `  - ${line}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `cycles:check passed (${files.length} files, ${edges} value edges, 0 cycles; ` +
      `${excludedTypes} type-only imports excluded, ${dynamicImports.length} dynamic import( ) calls not gated)`,
  );
}
