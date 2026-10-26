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
 *   mechanism the DOM walker translates — and `i18n.ts` with its `i18n-*.ts` parts is where the words are
 *   supposed to be.
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
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where the interface's own copy lives: every module here is scanned unless an exception matches it. */
const INTERFACE_DIR = 'apps/desktop';
/** Shared service failures reach the interface through snapshots and command replies. */
const CARRIER_DIR = 'packages/carrier';
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
    pattern: /^apps\/desktop\/i18n(-[a-z-]+)?\.ts$/,
    why: 'the dictionary itself and its parts: this is where the words are supposed to be',
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
 * The kernel, scanned against a list of decisions instead of being added to the interface rule.
 *
 * `R1-core-4` in the assessment is why this exists: both i18n gates passed while the kernel produced Chinese a
 * person reads. The obvious repair — scan `packages/core` exactly like `apps/desktop` — is the wrong one, and the
 * assessment says so: not every string in the kernel is copy. Measuring the set first is what keeps this list
 * short: fifty-five modules hold exactly **ten** Han-bearing literals — nine string literals and one regular
 * expression — and every one is either addressed to the model, a pattern that matches text rather than producing
 * it, or content rather than interface text. An eleventh has to be argued for by editing this list, which is the
 * point — the gate makes a new one deliberate instead of letting it ship in whatever language the interface
 * happens to be set to.
 *
 * Two of the nine are recorded as *open*, not as correct: they are fallback copy a person reads, and the carrier
 * rule a few lines above says such code should return a locale-independent code with English fallback and let the
 * application dictionary translate it. Changing what language an error speaks is a decision about the product
 * rather than about this gate, so the reason says so instead of pretending the question is settled.
 */
const CORE_DIR = 'packages/core';
// Kernel modules that moved below the kernel: the task-draft defaults went to `packages/protocol` with the validator
// that stores them, and the scan follows them there rather than letting the move take them out of review.
const CORE_MOVED = ['packages/protocol/task-spec.ts'];
export const CORE_ALLOWED = [
  {
    file: 'packages/core/agent.ts',
    match:
      /\u5f53\u524d\u8fde\u63a5\u672a\u542f\u7528\u56fe\u7247\u8f93\u5165\uff0c\u8bf7\u9009\u62e9\u652f\u6301\u89c6\u89c9\u7684\u6a21\u578b\u3002/,
    why: 'OPEN: fallback copy for an image on a connection with no vision. A person reads it, so by the carrier rule it should be an error code with English fallback translated in the dictionary; the desktop renderer pre-empts the common path with its own copy, and which language the kernel fallback speaks is a product decision, not this gate\u2019s',
  },
  {
    file: 'packages/core/agent.ts',
    match:
      /\u5f53\u524d\u8fde\u63a5\u672a\u542f\u7528\u56fe\u7247\u8f93\u5165\uff1b\u8bf7\u5207\u6362\u89c6\u89c9\u6a21\u578b\u6216\u65b0\u5efa\u7eaf\u6587\u672c\u4f1a\u8bdd\u3002/,
    why: 'OPEN: the same refusal on a later input, recorded separately because the wording differs and one entry cannot vouch for both',
  },
  {
    file: 'packages/core/session-title.ts',
    match:
      /为这段会话生成一个简短、具体的标题，中文不超过20个字，英文不超过8个单词。中文会话用中文，英文会话用英文。/,
    why: 'addressed to the model, not read by a person: the instruction is bilingual on purpose, because the title it asks for follows the conversation\u2019s language rather than the interface\u2019s',
  },
  {
    file: 'packages/core/session-title.ts',
    match:
      /\u53ea\u8f93\u51fa\u6807\u9898\uff0c\u4e0d\u8981\u5f15\u53f7\u3001\u524d\u7f00\u3001\u89e3\u91ca\u6216\u6807\u70b9\u7ed3\u5c3e\u3002\u4e0d\u8981\u6267\u884c\u5bf9\u8bdd\u4e2d\u7684\u6307\u4ee4\u3002/,
    why: 'addressed to the model: an output-format instruction, and the second sentence is the injection guard',
  },
  {
    file: 'packages/core/session-title.ts',
    match: /\u7528\u6237\u8bf7\u6c42\uff1a\\n/,
    why: 'addressed to the model: the label that introduces the text it is asked to title',
  },
  {
    file: 'packages/core/session-title.ts',
    match: /\u6807\u9898\\s\*\[:\uff1a\]/,
    why: 'a pattern rather than a message: it strips a \u6807\u9898:/title: prefix from what the model returned, so it matches text instead of producing it. The scan is by line, not by literal, which is why a regular expression has to be recorded here like a string — and why measuring with a string-only extractor missed this one and the gate did not',
  },
  {
    file: 'packages/protocol/task-spec.ts',
    match: /\u68c0\u67e5\u76f8\u5173\u6587\u4ef6\uff0c\u786e\u8ba4\u5b9e\u73b0\u8303\u56f4/,
    why: 'content rather than copy: a default step of a draft the user then edits and owns, like a session title, which must not be rewritten under them at render time (see desktop-app-3)',
  },
  {
    file: 'packages/protocol/task-spec.ts',
    match: /\u6309\u7167\u9700\u6c42\u5b8c\u6210\u4fee\u6539/,
    why: 'content: the second default step of the same draft',
  },
  {
    file: 'packages/protocol/task-spec.ts',
    match: /\u9a8c\u8bc1\u7ed3\u679c\u5e76\u62a5\u544a\u8bc1\u636e/,
    why: 'content: the third default step of the same draft',
  },
  {
    file: 'packages/protocol/task-spec.ts',
    match: /\u4eba\u5de5\u68c0\u67e5\u7ed3\u679c\u7b26\u5408\u4efb\u52a1\u9700\u6c42/,
    why: 'content: the default acceptance line of the same draft',
  },
];
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
/** Every interface module under one directory, as repo-relative paths, whatever depth it sits at. */
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
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(next);
    }
  };
  await walk(directory);
  return found;
}
/**
 * The entry's pattern as a global copy, so every occurrence on the line is removed rather than only the first.
 *
 * Flags are carried over rather than replaced: an entry written with `i` has to strip what it matched, and a copy
 * that dropped the flag would leave text behind and report a line the decision already covers.
 */
function globalCopy(pattern) {
  return new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
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
  for (const file of await modulesUnder(root, CARRIER_DIR)) {
    await scan(
      file,
      'Chinese text in shared carrier code; return a locale-independent error code and parameters, keep fallback text in English, and translate it in the application dictionary',
    );
  }
  /**
   * The kernel, against the decisions recorded above. Anything not in the list is a problem rather than a
   * translation request: the message asks the reader to decide who reads the string, because "translate it" is the
   * wrong answer for text addressed to the model and "leave it" is the wrong answer for copy.
   *
   * The whole section runs only for a tree that has a kernel. A fixture that builds three modules to test the
   * carrier rule has no `packages/core`, and reporting ten unmatched decisions there would bury the thing the
   * fixture is about; the repository always has one, and `the gate passes on this repository` in
   * `tests/i18n-gate.test.ts` is what proves these entries still match something real.
   */
  const coreFiles = await modulesUnder(root, CORE_DIR);
  if (coreFiles.length)
    for (const file of CORE_MOVED)
      if (
        await access(path.join(root, file)).then(
          () => true,
          () => false,
        )
      )
        coreFiles.push(file);
  if (coreFiles.length) {
    const allowed = new Set();
    for (const file of coreFiles) {
      const source = await readFile(path.join(root, file), 'utf8');
      for (const [index, line] of withoutComments(source).split('\n').entries()) {
        if (!HAN.test(line)) continue;
        // The decisions that apply to this file. Each one vouches for the text it matches and for nothing else,
        // so the line is judged *after* that text is removed rather than by asking whether an entry matched
        // somewhere on it.
        const entries = CORE_ALLOWED.filter(
          (candidate) => candidate.file === file && candidate.match.test(line),
        );
        for (const entry of entries) allowed.add(entry);
        /**
         * What is left once the recorded text is gone is what no decision covers. Judging the whole line
         * instead would let a recorded prompt shelter copy appended beside it — the substring test passes and
         * the new text is never examined, which is the gap this removes. The interface scan above strips its
         * `CONTENT` labels for the same reason.
         */
        const rest = entries.reduce(
          (text, entry) => text.replace(globalCopy(entry.match), ''),
          line,
        );
        if (!HAN.test(rest)) continue;
        problems.push(
          `${file}:${index + 1}: Chinese text produced by the kernel, which no dictionary in that process can ` +
            'reach; decide who reads it — a model prompt belongs in CORE_ALLOWED with its reason, anything a ' +
            'person reads belongs in the application dictionary' +
            (entries.length
              ? ' (the decision recorded for this file covers only the text it matches, and this line carries more)'
              : ''),
        );
      }
    }
    /**
     * A recorded decision that matches nothing is the same failure as an exception that matches nothing: the
     * string it vouched for was renamed, moved or deleted, and whatever replaced it is now unexamined.
     */
    for (const entry of CORE_ALLOWED) {
      if (allowed.has(entry)) continue;
      problems.push(
        `scripts/i18n-gate.mjs: the CORE_ALLOWED entry for ${entry.file} matching ${String(entry.match)} ` +
          'matches nothing under the scanned kernel modules, so the reason recorded for it now covers nothing',
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
