import type { ToolCall } from '../protocol/index.ts';

/**
 * Programs that only read, list or search files: what `read_file`, `search_files` and `list_files` already do
 * bounded, paged and without a command approval. `sed` and `find` count only in their read-only forms.
 */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'type',
  'ls',
  'dir',
  'tree',
  'grep',
  'egrep',
  'rg',
  'findstr',
  'wc',
  'get-content',
  'gc',
  'get-childitem',
  'gci',
  'select-string',
  'sls',
]);

/**
 * The reading program a command consists of, when every part of it only reads files; otherwise nothing.
 *
 * Every segment of a pipeline or command list has to be a read: `npm test | grep fail` runs a test and only filters
 * its output, which no file tool can do, so it is never named. A redirect writes, so it disqualifies the command too.
 */
export function shellRead(command: string): string | undefined {
  if (/[>`]|\$\(/.test(command)) return undefined;
  const segments = command.split(/\|\|?|&&|;/);
  let first: string | undefined;
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const program = words[0]?.toLowerCase().replace(/\.exe$/, '');
    if (!program) return undefined;
    const reads =
      READERS.has(program) ||
      (program === 'sed' && words.includes('-n') && !words.some((word) => word.startsWith('-i'))) ||
      (program === 'find' && !words.some((word) => /^-(exec|execdir|ok|delete|fprint)/.test(word)));
    if (!reads) return undefined;
    first ??= program;
  }
  return first;
}

/** The first `run_command` call in a round that only read files, as the program it used. */
export function shellReadIn(calls: readonly ToolCall[]): string | undefined {
  for (const call of calls) {
    if (call.name !== 'run_command' || typeof call.arguments.command !== 'string') continue;
    const program = shellRead(call.arguments.command);
    if (program) return program;
  }
  return undefined;
}

/**
 * Said once per run, after the first command that only read files.
 *
 * Advice rather than a refusal: the command ran and its result stands. The prompt already says this, but a model
 * that reaches for `cat` anyway is told so where it acts, and only once, so the note does not become noise that a
 * later round learns to ignore.
 */
export function shellReadNotice(program: string): string {
  return (
    '<runtime-context source="tool-advice">\n' +
    `The last run_command only read files (${program}). Use read_file, search_files and list_files for that: they are bounded and paged, and need no command approval. Keep run_command for building, testing and running programs.\n` +
    '</runtime-context>'
  );
}
