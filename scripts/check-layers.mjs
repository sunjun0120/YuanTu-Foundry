/**
 * Package layering, gated: a package under `packages/` may import only packages of a strictly lower layer.
 *
 * `cycles:check` keeps the *file* graph acyclic over value imports. That says nothing about direction: `protocol`
 * could still borrow a type from `core`, and `storage` a helper from `core`, without any file cycle appearing —
 * which is how the type source ended up depending on the kernel it describes. This gate states the intended
 * direction once and refuses every edge against it, type imports included, because a type borrowed upward is
 * still a dependency a reader has to follow.
 *
 * Moving a package between layers is a deliberate edit to `LAYERS`, not something an import can do by accident.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/** Lowest first. Packages on one row must not import each other. */
const LAYERS = [
  ['protocol', 'platform'],
  ['providers', 'search', 'storage'],
  ['maintenance', 'workspaces'],
  ['tools'],
  ['lsp', 'office', 'resources'],
  ['knowledge', 'mcp'],
  ['catalog'],
  ['core'],
  ['client'],
  ['carrier'],
];

const root = process.cwd();
const packagesRoot = path.join(root, 'packages');
const rank = new Map(LAYERS.flatMap((row, index) => row.map((name) => [name, index])));

async function sources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(full)));
    else if (/\.(?:ts|mts|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function specifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      found.push(node.argument.literal.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const packageOf = (file) => path.relative(packagesRoot, file).split(path.sep)[0];
const problems = [];
const directories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const name of directories)
  if (!rank.has(name)) problems.push(`packages/${name} has no layer in scripts/check-layers.mjs`);

let edges = 0;
for (const file of await sources(packagesRoot)) {
  const from = packageOf(file);
  if (!rank.has(from)) continue;
  for (const specifier of specifiers(file, await readFile(file, 'utf8'))) {
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(packagesRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const to = packageOf(target);
    if (to === from) continue;
    edges++;
    if (!rank.has(to) || rank.get(to) >= rank.get(from))
      problems.push(
        `${path.relative(root, file).replaceAll('\\', '/')} imports ${specifier} (${from} → ${to} goes against the layer order)`,
      );
  }
}

if (problems.length) {
  console.error(`layers:check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `layers:check passed (${rank.size} packages in ${LAYERS.length} layers, ${edges} cross-package imports)`,
);
