/**
 * Package layering and the React boundary, gated.
 *
 * Two rules about direction, both stated here once because neither is visible in a single import:
 *
 * 1. **Layers.** A package under `packages/` may import only packages of a strictly lower layer, and an entry under
 *    `apps/` may import any package and only apps of a strictly lower layer. No package imports an app.
 *    `cycles:check` keeps the *file* graph acyclic over value imports, which says nothing about direction:
 *    `protocol` could still borrow a type from `core` without any file cycle appearing — which is how the type
 *    source ended up depending on the kernel it describes.
 *
 * 2. **The React boundary.** Node's test runner strips types from `.ts` but cannot parse `.tsx`, so a plain module
 *    that reaches a component turns every test importing it into a syntax error. Only `apps/desktop/renderer.ts`
 *    (the entry that mounts the tree) and the TSX files under `ui/` (which compose each other) may reach a
 *    component; every other `.ts` module must stay JSX-free. The check is transitive and includes type imports,
 *    because a type borrowed from a component is still a dependency on JSX.
 *
 * Moving a package between layers is a deliberate edit to `LAYERS`, not something an import can do by accident;
 * widening the React boundary is a deliberate edit to `TSX_BOUNDARY_EXEMPT`.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/** Lowest first. Packages on one row must not import each other. */
const LAYERS = [
  ['formats'],
  ['protocol', 'platform'],
  ['providers', 'sandbox', 'search', 'storage'],
  ['maintenance', 'workspaces'],
  ['tools'],
  ['lsp', 'office', 'resources'],
  ['knowledge', 'mcp'],
  ['builtin-services'],
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
/**
 * The packages an app may import, for the apps that must not assemble a kernel themselves.
 *
 * The layer order lets an app import any package, which is right for the Host and the CLI and wrong for the
 * desktop: it reaches the kernel only through a Host it talks to over `carrier`, so an import of `core`, `tools`
 * or `storage` from its main process is a second, unsupervised copy of state the Host owns. Widening this list is
 * a deliberate edit, the same as moving a package between layers. An entry naming a file (`storage/x.ts`) admits
 * that one module and nothing else of its package.
 */
const APP_PACKAGES = new Map([
  [
    'apps/desktop',
    new Set([
      'builtin-services',
      'carrier',
      'client',
      'formats',
      'maintenance',
      'office',
      'platform',
      'protocol',
      'providers',
      'resources',
      'sandbox',
      // The cross-project search reads unopened projects' indexes without starting a Host per project; the
      // reader checks the schema version so a database another build migrated is reported, not misread.
      'storage/session-index-reader.ts',
    ]),
  ],
]);
/** The one non-TSX module allowed to reach a component: the entry that mounts the React tree. */
const TSX_BOUNDARY_EXEMPT = new Set(['apps/desktop/renderer.ts']);
/** Every module the gates read: TSX is scanned so the boundary check can see its edges. */
const SOURCE_FILE = /\.(?:ts|mts|mjs|tsx)$/;
const TSX_FILE = /\.tsx$/;
/** Extensions a relative specifier may leave out; the repository writes them, a fixture or a future file may not. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs'];
const INDEX_FILES = ['index.ts', 'index.tsx'];

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
    if (entry.isDirectory() && entry.name === 'target' && existsSync(path.join(dir, 'Cargo.toml')))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(full)));
    else if (SOURCE_FILE.test(entry.name)) found.push(full);
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

/** The file a relative specifier names, or undefined when it points outside this tree. */
function resolveSpecifier(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(file), specifier);
  for (const candidate of [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...INDEX_FILES.map((name) => path.join(base, name)),
  ])
    if (existsSync(candidate)) return candidate;
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

const files = [...(await sources(packagesRoot)), ...(await sources(appsRoot))];
let edges = 0;
for (const file of files) {
  const from = unitOf(file);
  if (!rank.has(from)) continue;
  for (const specifier of specifiers(file, await readFile(file, 'utf8'))) {
    if (!specifier.startsWith('.')) continue;
    const to = unitOf(path.resolve(path.dirname(file), specifier));
    if (to === undefined || to === from) continue;
    // Packages sit below every app, so only app-to-app edges need the order; an app with a package list is
    // held to it instead.
    if (from.startsWith('apps/') && !to.startsWith('apps/')) {
      const allowed = APP_PACKAGES.get(from);
      const module = path
        .relative(packagesRoot, path.resolve(path.dirname(file), specifier))
        .replaceAll('\\', '/');
      if (allowed && !allowed.has(to) && !allowed.has(module))
        problems.push(
          `${path.relative(root, file).replaceAll('\\', '/')} imports ${specifier} (${from} may not import packages/${to}; see APP_PACKAGES)`,
        );
      continue;
    }
    edges++;
    if (!rank.has(to) || rank.get(to) >= rank.get(from))
      problems.push(
        `${path.relative(root, file).replaceAll('\\', '/')} imports ${specifier} (${from} → ${to} goes against the layer order)`,
      );
  }
}

/**
 * Who can reach a component, walking importers backwards from every TSX file.
 *
 * Marking the components themselves first means "can reach" is the same relation for a `.ts` two hops away and one
 * that imports the component directly: both are importers of a marked module.
 */
const importers = new Map();
for (const file of files) {
  for (const specifier of specifiers(file, await readFile(file, 'utf8'))) {
    const target = resolveSpecifier(file, specifier);
    if (!target) continue;
    const list = importers.get(target);
    if (list) list.push(file);
    else importers.set(target, [file]);
  }
}
const reachesComponent = new Set();
const queue = files.filter((file) => TSX_FILE.test(file));
while (queue.length) {
  const current = queue.pop();
  if (reachesComponent.has(current)) continue;
  reachesComponent.add(current);
  for (const importer of importers.get(current) ?? [])
    if (!reachesComponent.has(importer)) queue.push(importer);
}
for (const file of files) {
  if (TSX_FILE.test(file)) continue;
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (TSX_BOUNDARY_EXEMPT.has(relative)) continue;
  if (!reachesComponent.has(file)) continue;
  problems.push(
    `${relative} reaches a .tsx module (only apps/desktop/renderer.ts and TSX files under apps/desktop/ui may; ` +
      'the Node test runner cannot load a component)',
  );
}

if (problems.length) {
  console.error(`layers:check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `layers:check passed (${LAYERS.flat().length} packages in ${LAYERS.length} layers, ${APP_LAYERS.flat().length} apps in ${APP_LAYERS.length} layers, ${edges} ordered imports)`,
);
