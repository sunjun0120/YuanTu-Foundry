/**
 * The language gate, as a scan over the process rather than a list of files.
 *
 * `desktop.smoke.mjs` walks the page after switching to `en-US` and fails on any Chinese it can still see, which is
 * the right test for the renderer: its source text is Chinese and a walker translates it at render time, so "what
 * the user sees" is exactly what can be checked. That test cannot see the *main* process. A validation message, a
 * failure dialog or a settings reply is written in a process with no DOM and handed to a page that may already be
 * in another language, and nothing noticed that those strings were Chinese whatever the interface language was.
 *
 * The rule is the one that fits the mechanism: **a module whose text a person reads keeps its words in
 * `apps/desktop/i18n.ts`**, and a Chinese character in one of them means either copy that belongs in the dictionary
 * or a comment, which this codebase does not write. Comments are stripped before the scan, so the rule is about
 * code rather than about prose.
 *
 * The first version of this gate named six files. A list is the wrong shape for the question — a seventh module is
 * covered by nothing at all, and `mcp-settings.ts` was one: a Chinese string added there would have shipped in
 * whatever language the interface was set to. So the scan is the directory now, and the *exceptions* are the list.
 * Each exception carries its reason and is checked to still match something, because a rename that quietly empties
 * an exception leaves a module unguarded, which is the failure this gate exists to prevent.
 *
 * The two exceptions are different rules rather than one rule with holes:
 *
 * - **The renderer's own modules and the dictionary.** `renderer*.ts` and `session-management.ts` (which imports
 *   `document` and is reached only from `renderer.ts`) carry Chinese *source* text on purpose — that is the
 *   mechanism the DOM walker translates — and `i18n.ts` is where the words are supposed to be.
 *   `attachment-contract.ts` composes the prompts sent to the model: instructions are not copy, and putting them in
 *   the interface's dictionary would be a different bug.
 * - **Guest workers.** `packages/tools/*worker*.ts` runs model-authored code and shell commands in a process of its
 *   own. Its text reaches the model or the caller's log and never a person with a locale, so the answer there is
 *   not "translate it" but "keep it in English": there is no walker to translate it and no dictionary in that
 *   process. A *desktop* worker is deliberately not in this group — it belongs to the interface's own process and
 *   its failures are read by a person, so it follows the interface rule.
 *
 * `CONTENT` is the same distinction inside a scanned file: the labels the readers put *into* extracted text — the
 * PDF page label and the sheet label — are what the model reads, so they follow the file rather than the interface.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where the interface's own copy lives: every module here is scanned unless an exception matches it. */
const INTERFACE_DIR = 'apps/desktop';
/**
 * Where a worker's text is data rather than copy, scanned by name because that is what makes it a worker.
 *
 * The scan is by convention on purpose: a new guest worker is covered by being named like the others, which is the
 * one thing a worker cannot avoid — the name is how its spawner finds it.
 */
const WORKER_DIRS = ['packages/tools', 'packages/mcp'];
const WORKER_NAME = /worker[^/\\]*\.ts$/;
/** Exceptions to the interface scan, each one a rule with a reason rather than a file somebody liked. */
export const EXCLUSIONS = [
  {
    pattern: /^apps\/desktop\/renderer[^/]*\.ts$/,
    why: 'the renderer is translated at render time: its Chinese source text is the mechanism, and the DOM walker checks what a person ends up seeing',
  },
  {
    pattern: /^apps\/desktop\/i18n\.ts$/,
    why: 'the dictionary itself: this is where the words are supposed to be',
  },
  {
    pattern: /^apps\/desktop\/session-management\.ts$/,
    why: 'looks like a main-process module but imports document and is only reached from renderer.ts',
  },
  {
    pattern: /^apps\/desktop\/attachment-contract\.ts$/,
    why: 'composes the prompts sent to the model; instructions rather than something a person reads',
  },
];
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/**
 * Labels that belong to the content rather than to the interface, written as escapes so this file stays ASCII:
 * `第 N 页` (a PDF page, built as a concatenation in one place and matched as a pattern in another, hence the
 * gap-sized span) and `工作表：` (a worksheet).
 */
const CONTENT = [/\u7b2c[^\u9875]{0,16}\u9875/, /\u5de5\u4f5c\u8868\uff1a/];
/**
 * The source with comments removed and string bodies left alone.
 *
 * The direction matters: what has to be *found* lives inside string literals, and what has to be *ignored* lives in
 * comments, so this keeps every literal and deletes `//` and block comments. A regex literal containing a quote
 * could still be misread as the start of a string, which can only hide a later comment — and that costs nothing
 * here, because a comment has no Chinese in it by the rule above. Nothing is rewritten: this is a scan.
 *
 * A block comment's own line breaks are kept, because the line number in a report is how somebody finds the string:
 * a skipped comment that swallowed its newlines would point every later report at the wrong line, and the files this
 * scans are full of multi-line documentation.
 */
export function withoutComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    const character = source[index];
    if (pair === '//') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (pair === '/*') {
      const end = source.indexOf('*/', index + 2);
      const comment = source.slice(index, end === -1 ? source.length : end + 2);
      out += '\n'.repeat(comment.split('\n').length - 1);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      out += character;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === character) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}
/** Every `.ts` module under one directory, as repo-relative paths, whatever depth it sits at. */
async function modulesUnder(root, directory) {
  const found = [];
  const walk = async (relative) => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) found.push(next);
    }
  };
  await walk(directory);
  return found;
}
/**
 * Every problem the gate can see, as `path:line: why` lines, plus the exceptions that matched nothing.
 *
 * Exported rather than run on import so the rule can be tested on a tree that is not this repository — the tests
 * build a small one and add a Chinese string to a module the old list-shaped gate did not name.
 */
export async function scanI18n(root) {
  const problems = [];
  const interfaceFiles = await modulesUnder(root, INTERFACE_DIR);
  const matched = new Set();
  const scan = async (file, message) => {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const [index, line] of withoutComments(source).split('\n').entries()) {
      if (!HAN.test(line)) continue;
      // A line whose *only* Chinese is a content label is content; one that carries copy as well is still
      // reported, so the exemption cannot hide a message by sharing a line with a label.
      const rest = CONTENT.reduce((text, pattern) => text.replace(pattern, ''), line);
      if (!HAN.test(rest)) continue;
      problems.push(`${file}:${index + 1}: ${message}`);
    }
  };
  for (const file of interfaceFiles) {
    const exclusion = EXCLUSIONS.find((entry) => entry.pattern.test(file));
    if (exclusion) {
      matched.add(exclusion);
      continue;
    }
    await scan(
      file,
      'Chinese text in a module a person reads; move it to apps/desktop/i18n.ts and read it with mainText()',
    );
  }
  for (const directory of WORKER_DIRS) {
    for (const file of await modulesUnder(root, directory)) {
      if (!WORKER_NAME.test(file)) continue;
      await scan(
        file,
        "Chinese text in a guest worker; its words reach the model or a caller's log rather than a person, so keep the worker's own text in English (a caller that shows it to somebody owns the copy)",
      );
    }
  }
  for (const exclusion of EXCLUSIONS) {
    if (matched.has(exclusion)) continue;
    problems.push(
      `scripts/i18n-gate.mjs: the exception ${String(exclusion.pattern)} matches no module under ${INTERFACE_DIR}; if that file was renamed, moved or deleted, this exception now covers something else and the module it named is unguarded`,
    );
  }
  return problems;
}
