/**
 * Package layering, gated: a package under `packages/` may import only packages of a strictly lower layer, and an
 * entry under `apps/` may import any package and only apps of a strictly lower layer. No package imports an app.
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
  ['formats'],
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
/**
 * Entries, above every package. `shared` is the one assembly point the Host and the CLI build the kernel with; the
 * desktop starts a Host as a child process and talks to it through `packages/carrier`, so it imports no other app.
 */
const APP_LAYERS = [['shared'], ['agent-host', 'cli', 'desktop']];

const root = process.cwd();
const packagesRoot = path.join(root, 'packages');
const appsRoot = path.join(root, 'apps');
/** Units are named `name` for a package and `apps/name` for an app, so the two namespaces cannot collide. */
const rank = new Map([
  ...LAYERS.flatMap((row, index) => row.map((name) => [name, index])),
  ...APP_LAYERS.flatMap((row, index) => row.map((name) => [`apps/${name}`, LAYERS.length + index])),
]);

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

/** The unit a path belongs to (`core`, `apps/desktop`), or undefined outside `packages/` and `apps/`. */
function unitOf(file) {
  for (const [base, prefix] of [
    [packagesRoot, ''],
    [appsRoot, 'apps/'],
  ]) {
    const relative = path.relative(base, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative))
      return prefix + relative.split(path.sep)[0];
  }
  return undefined;
}
const problems = [];
for (const [base, prefix] of [
  [packagesRoot, ''],
  [appsRoot, 'apps/'],
]) {
  const directories = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => prefix + entry.name);
  for (const name of directories)
    if (!rank.has(name))
      problems.push(`${prefix ? '' : 'packages/'}${name} has no layer in scripts/check-layers.mjs`);
}

let edges = 0;
for (const file of [...(await sources(packagesRoot)), ...(await sources(appsRoot))]) {
  const from = unitOf(file);
  if (!rank.has(from)) continue;
  for (const specifier of specifiers(file, await readFile(file, 'utf8'))) {
    if (!specifier.startsWith('.')) continue;
    const to = unitOf(path.resolve(path.dirname(file), specifier));
    if (to === undefined || to === from) continue;
    // An app may use any package: packages sit below every app, so only app-to-app edges need the order.
    if (from.startsWith('apps/') && !to.startsWith('apps/')) continue;
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
  `layers:check passed (${LAYERS.flat().length} packages in ${LAYERS.length} layers, ${APP_LAYERS.flat().length} apps in ${APP_LAYERS.length} layers, ${edges} ordered imports)`,
);
