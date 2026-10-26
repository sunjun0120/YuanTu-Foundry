/**
 * Rewrite interface copy from Chinese literals into `t('key')` calls, using the dictionary as the only source.
 *
 * The renderer's old mechanism is "Chinese source text + a DOM walker that translates what it sees". The React
 * layer cannot use it: the i18n gate scans `ui/` for Chinese, so a component has to render through the
 * dictionary. Rewriting those literals by hand is where copy gets silently altered, so this script does the
 * mechanical part and reports everything it will not guess:
 *
 * - an exact match becomes `t('key')` (the dictionary's `[zh, en]` pair is already in `apps/desktop/i18n.ts`);
 * - a template literal becomes `t('key', { name: expression })`, matching the dictionary's `{name}` placeholders
 *   positionally;
 * - JSX text becomes `{t('key')}` and a JSX attribute value becomes `{t('key')}`;
 * - a string with no entry is reported, not invented; a Chinese string that maps to more than one key is reported
 *   and left alone, because choosing one would be a guess about the sentence rather than a rewrite.
 *
 * It is a migration tool, not a build step: dry-run by default, `--write` to apply, prettier afterwards. Running it
 * twice is a no-op because the second run has no Chinese literal left to match.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { dictionaryEntries } from '../apps/desktop/i18n.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICTIONARY = path.join(root, 'apps/desktop/i18n.ts');
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const PLACEHOLDER = /\{([a-zA-Z][\w]*)\}/g;
/** Calls whose argument is already a translated string; rewriting inside them would nest `t(t())`. */
const TRANSLATED_CALLS = new Set(['t', 'translate']);

const entries = dictionaryEntries();
/** `zh → key`, plus the zh strings the dictionary spells with more than one key. */
const exact = new Map();
const collisions = new Map();
for (const [key, zh] of entries) {
  const held = exact.get(zh);
  if (held === undefined) exact.set(zh, key);
  else if (held !== key) {
    if (!collisions.has(zh)) collisions.set(zh, [held]);
    collisions.get(zh).push(key);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A dictionary template as a matcher: each `{name}` is a placeholder in the sentence. */
function templateMatcher(zh) {
  let source = '';
  let index = 0;
  const names = [];
  for (const match of zh.matchAll(PLACEHOLDER)) {
    source += escapeRegExp(zh.slice(index, match.index));
    source += '(.+?)';
    names.push(match[1]);
    index = match.index + match[0].length;
  }
  source += escapeRegExp(zh.slice(index));
  return { matcher: new RegExp(`^${source}$`, 's'), names };
}

const templates = entries
  .filter(([, zh]) => /\{[a-zA-Z][\w]*\}/.test(zh))
  .map(([key, zh]) => ({ key, zh, ...templateMatcher(zh) }));

function isTranslatedCall(node) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    TRANSLATED_CALLS.has(parent.expression.text)
  );
}
function isModuleSpecifier(node) {
  return (
    ts.isImportDeclaration(node.parent) ||
    ts.isExportDeclaration(node.parent) ||
    ts.isExternalModuleReference(node.parent)
  );
}
function isPropertyName(node) {
  return (
    (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
    node.parent.name === node
  );
}

/** The `t(...)` call for one key, with the named values the dictionary template declares. */
function callText(key, values = []) {
  const quoted = `'${key}'`;
  if (!values.length) return `t(${quoted})`;
  const named = values.filter((value) => value.name !== undefined);
  if (named.length !== values.length)
    return `t(${quoted}, { ${values.map((value, index) => `value${index + 1}: ${value.text}`).join(', ')} })`;
  return `t(${quoted}, { ${named
    .map((value) => (value.shorthand ? value.name : `${value.name}: ${value.text}`))
    .join(', ')} })`;
}

/** The replacement for one literal, or why it cannot be rewritten. */
function literalReplacement(node) {
  if (isTranslatedCall(node) || isModuleSpecifier(node) || isPropertyName(node)) return undefined;
  const text = node.text;
  if (!HAN.test(text)) return undefined;
  if (collisions.has(text)) return { problem: 'collision', text };
  const key = exact.get(text);
  if (key === undefined) return { problem: 'missing', text };
  const call = callText(key);
  // A JSX attribute is the one place the call has to be wrapped in an expression container.
  if (ts.isJsxAttribute(node.parent) && node.parent.initializer === node)
    return { text: `{${call}}` };
  return { text: call };
}

function templateReplacement(node, sourceFile) {
  if (isTranslatedCall(node)) return undefined;
  // A template expression's literal parts are the head plus each span's literal: one more quasi than expressions.
  const quasis = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  const expressions = node.templateSpans.map((span) => span.expression);
  if (!HAN.test(quasis.join(''))) return undefined;
  let source = '';
  for (const [index, quasi] of quasis.entries()) {
    source += escapeRegExp(quasi);
    if (index < expressions.length) source += '(.+?)';
  }
  const matcher = new RegExp(`^${source}$`, 's');
  for (const template of templates) {
    if (!matcher.test(template.zh)) continue;
    const values = expressions.map((expression, position) => {
      const name = template.names[position];
      const text = expression.getText(sourceFile);
      return { name, text, shorthand: ts.isIdentifier(expression) && expression.text === name };
    });
    return { text: callText(template.key, values) };
  }
  return { problem: 'missing', text: quasis.join('${…}') };
}

function importsTranslation(sourceFile) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith('i18n.ts') &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) =>
        TRANSLATED_CALLS.has(element.name.text),
      ),
  );
}

async function filesUnder(target) {
  if (!(await stat(target)).isDirectory()) return [target];
  const found = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

async function migrate(file, { write, importSpecifier }) {
  const raw = await readFile(file, 'utf8');
  // A byte-order mark stays at the start of the file: inserting the import before it would put it mid-file.
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? raw.slice(1) : raw;
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const edits = [];
  const problems = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const replacement = literalReplacement(node);
      if (replacement?.problem) problems.push(replacement);
      else if (replacement)
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: replacement.text,
        });
    } else if (ts.isTemplateExpression(node)) {
      const replacement = templateReplacement(node, sourceFile);
      if (replacement?.problem) problems.push(replacement);
      else if (replacement)
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: replacement.text,
        });
    } else if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (HAN.test(trimmed)) {
        const key = exact.get(trimmed);
        if (key !== undefined && !collisions.has(trimmed)) {
          const leading = node.text.slice(0, node.text.indexOf(trimmed));
          const trailing = node.text.slice(node.text.indexOf(trimmed) + trimmed.length);
          edits.push({
            start: node.getStart(sourceFile),
            end: node.getEnd(),
            text: `${leading}{${callText(key)}}${trailing}`,
          });
        } else
          problems.push({
            problem: collisions.has(trimmed) ? 'collision' : 'missing',
            text: trimmed,
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!edits.length) return { file, changed: 0, problems };
  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  if (!importsTranslation(sourceFile)) {
    const specifier = importSpecifier ?? relativeSpecifier(file);
    const line = `import { t } from '${specifier}';`;
    const anchor = sourceFile.statements.findLast((statement) => ts.isImportDeclaration(statement));
    if (anchor) {
      const insertAt = anchor.getEnd();
      output = `${output.slice(0, insertAt)}\n${line}${output.slice(insertAt)}`;
    } else output = `${line}\n${output}`;
  }
  if (write) await writeFile(file, bom + output, 'utf8');
  return { file, changed: edits.length, problems, output };
}

/** The import path from a migrated file back to `apps/desktop/i18n.ts`, as the renderer writes it. */
function relativeSpecifier(file) {
  const relativePath = path.relative(path.dirname(file), DICTIONARY).replaceAll('\\', '/');
  if (path.isAbsolute(relativePath))
    throw new Error(
      `${relative(file)} is outside the repository; pass --import-specifier for its i18n.ts import`,
    );
  return relativePath.replace(/^([^./])/, './$1');
}

const args = process.argv.slice(2);
const write = args.includes('--write');
let importSpecifier;
const targets = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--write' || argument === '--dry-run') continue;
  if (argument === '--import-specifier') {
    importSpecifier = args[index + 1];
    index += 1;
    continue;
  }
  if (argument.startsWith('--')) {
    console.error(`unknown option: ${argument}`);
    process.exit(2);
  }
  targets.push(argument);
}
if (!targets.length) {
  console.error(
    'usage: node scripts/migrate-ui-copy.mjs [--dry-run|--write] [--import-specifier ./i18n.ts] <file-or-directory>...',
  );
  process.exit(2);
}
let changed = 0;
let failures = 0;
for (const target of targets) {
  for (const file of await filesUnder(path.resolve(target))) {
    const result = await migrate(file, { write, importSpecifier });
    changed += result.changed;
    for (const problem of result.problems) {
      failures += 1;
      console.error(
        `${relative(file)}: ${problem.problem === 'collision' ? 'collision, left alone' : 'no dictionary entry'}: ${problem.text}`,
      );
    }
    if (result.changed)
      console.log(
        `${relative(file)}: ${result.changed} replacement(s)${write ? '' : ' (dry run)'}`,
      );
  }
}
console.log(
  `${write ? 'rewrote' : 'would rewrite'} ${changed} literal(s); ${failures} need a person`,
);
if (failures) process.exitCode = 1;
