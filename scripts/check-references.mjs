/**
 * The paths the documents and the gates point at, checked.
 *
 * `docs:check` (`scripts/docs-facts.mjs`) keeps the *numbers* in the documentation honest, and it cannot see the
 * other half of the same problem: a document naming a file that no longer exists reads exactly like one naming a
 * file that does, and the reader finds out by trying. This repository has already paid for that once — `ci.yml`
 * named `tests/lsp-real.test.ts` and a validation record that the first cleanup had deleted, and the only reason
 * it was found is that somebody went looking. A dangling reference is cheap to write and expensive to notice.
 *
 * So this is the cheap subset of what the harness does with its `verify-*` scripts: every reference to a path in
 * a file that is supposed to describe the repository *now* has to resolve, and every `#anchor` in a markdown
 * link has to name a heading or an explicit `<a id>` in the file it points at.
 *
 * What is scanned, and why each one:
 *
 * - `README.md` — every backticked token shaped like a path in this repository, plus every markdown link.
 * - every other document under `docs/` — its markdown links. Dated records
 *   (`docs/capability-comparison-*.md`, `docs/validation-*.md`) report what was read on the day they were
 *   written and are never rewritten, so their backticked `path:line` quotes are left alone: their whole point is
 *   to name what that day's tree held. A link is still a link in a record, so links are checked there too.
 * - `.github/workflows/*.yml` — the job steps. This is where a reference to a deleted file becomes a CI failure
 *   with no explanation, and where the aggregate `npm run check` is the answer to "did every gate run".
 * - `package.json` — the `scripts` values, because every one of them is an entry point somebody types.
 *
 * What is deliberately not a candidate, because a gate that cries wolf gets deleted:
 *
 * - globs and placeholders (`tests/*.test.ts`, `.yuantu/spill/<session>/`): they describe a shape, not a file.
 * - paths outside the directories this repository owns (`.yuantu/…`, `.claude/…`, `~/.yuantu/…`): those are the
 *   user's files, and their absence from a clone is not a defect.
 * - URLs, site-absolute paths, and `path:line` suffixes.
 *
 * `ALLOWED_MISSING` is empty, and it is meant to stay that way: a reference to something that is not there is
 * either a typo or a deletion nobody finished, and both want fixing rather than listing. An entry here would
 * need a sentence saying why the reference has to stay.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The directories whose contents this repository owns, and therefore can promise exist. */
const OWNED_DIRECTORIES = [
  '.github',
  'apps',
  'benchmarks',
  'docs',
  'examples',
  'packages',
  'scripts',
  'tests',
];
/** Records, not descriptions: excluded from the backticked-path scan (see the header). */
const HISTORICAL = [/^docs[\\/](?:capability-comparison|validation)-/];
const ALLOWED_MISSING = new Set([]);

const problems = [];
const textCache = new Map();

async function exists(absolute) {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}
async function textOf(file) {
  if (!textCache.has(file)) textCache.set(file, await readFile(path.join(root, file), 'utf8'));
  return textCache.get(file);
}
/**
 * A token shaped like a path in this repository, or `undefined`.
 *
 * The shape test is what does the filtering: requiring at least one `/` and allowing only word characters,
 * dots, dashes, `@` and `+` in each segment rules out globs, placeholders, URLs, switches and prose in one
 * expression, and the first-segment test rules out the user's own directories.
 */
function repoPath(token) {
  const value = token
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/[),.;:]+$/, '');
  if (!/^[\w.@+-]+(?:\/[\w.@+-]+)+$/.test(value)) return undefined;
  if (!OWNED_DIRECTORIES.includes(value.split('/')[0])) return undefined;
  return value;
}
/** Every `` `…` `` span on one line. */
function backticked(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}
/** Every whitespace-separated token on one line, with the quotes and YAML punctuation taken off. */
function words(line) {
  return line
    .split(/\s+/)
    .map((word) => word.replace(/^[-'"\s]+/, '').replace(/['",\s]+$/, ''))
    .filter(Boolean);
}
/** A heading's anchor, the way the platform derives one: lower case, punctuation dropped, spaces hyphenated. */
function slug(heading) {
  return heading
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}
/**
 * Every anchor a markdown file answers to: the explicit `<a id>` tags the table of contents links to, and the
 * derived slugs of its headings. Fenced blocks are removed first, so a `# comment` inside a shell sample is not
 * mistaken for a heading.
 */
async function anchorsIn(file) {
  const text = await textOf(file);
  const anchors = new Set();
  for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) anchors.add(slug(match[1]));
  return anchors;
}

async function checkPath(token, at) {
  const value = repoPath(token);
  if (!value || ALLOWED_MISSING.has(value)) return;
  if (!(await exists(path.join(root, value)))) problems.push(`${at}: \`${token}\` does not exist`);
}

async function checkLink(file, raw, at) {
  const target = raw.replace(/^<|>$/g, '');
  if (!target || target.startsWith('/')) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return;
  const hash = target.indexOf('#');
  const filePart = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? '' : target.slice(hash + 1);
  const targetFile = filePart ? path.posix.join(path.posix.dirname(file), filePart) : file;
  if (filePart && !(await exists(path.join(root, targetFile)))) {
    problems.push(`${at}: the link target ${target} does not exist`);
    return;
  }
  if (!fragment || !targetFile.endsWith('.md')) return;
  let wanted = fragment;
  try {
    wanted = decodeURIComponent(fragment);
  } catch {
    /* A fragment that is not percent-encoded is compared as written. */
  }
  if (!(await anchorsIn(targetFile)).has(wanted))
    problems.push(`${at}: ${target} names no anchor #${fragment}`);
}

/** The files that describe the repository now, plus the two places a path becomes a command. */
async function sources() {
  const found = [{ file: 'README.md', kind: 'markdown' }];
  const list = async (directory) => {
    try {
      return await readdir(path.join(root, directory));
    } catch (error) {
      // A clone may have no `docs/` or no workflows; that is not a dangling reference.
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };
  for (const name of await list('docs'))
    if (name.endsWith('.md')) found.push({ file: `docs/${name}`, kind: 'markdown' });
  for (const name of await list(path.join('.github', 'workflows')))
    if (name.endsWith('.yml') || name.endsWith('.yaml'))
      found.push({ file: `.github/workflows/${name}`, kind: 'text' });
  found.push({ file: 'package.json', kind: 'package-json' });
  return found;
}

async function check() {
  for (const source of await sources()) {
    if (source.kind === 'package-json') {
      const manifest = JSON.parse(await textOf(source.file));
      for (const [name, command] of Object.entries(manifest.scripts ?? {}))
        for (const word of words(String(command)))
          await checkPath(word, `package.json scripts.${name}`);
      continue;
    }
    const lines = (await textOf(source.file)).split('\n');
    const living = !HISTORICAL.some((pattern) => pattern.test(source.file));
    for (let index = 0; index < lines.length; index++) {
      const at = `${source.file}:${index + 1}`;
      if (source.kind === 'markdown') {
        for (const target of [...lines[index].matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)])
          await checkLink(source.file, target[1], at);
        if (living) for (const token of backticked(lines[index])) await checkPath(token, at);
      } else {
        for (const word of words(lines[index])) await checkPath(word, at);
      }
    }
  }
  return problems;
}

const found = await check();
if (found.length) {
  console.error('references:check failed:\n' + found.map((line) => `  - ${line}`).join('\n'));
  process.exitCode = 1;
} else console.log('references:check passed');
