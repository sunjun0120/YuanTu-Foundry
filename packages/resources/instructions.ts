import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';

const names = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'] as const;

/**
 * How much of a project's own instructions one request carries.
 *
 * These two numbers used to decide whether the run happened at all: a selected file over 32KB, or a tree over
 * 64KB in total, threw from `loadInstructions`, and that throw lands in the prompt-assembly stage of *every*
 * run in the workspace. One oversized `AGENTS.md` therefore made a workspace unusable until somebody edited the
 * file by hand — and the workspaces that most need an agent are the ones with the most instructions to read.
 *
 * They are a rendering budget now. What fits is rendered, what does not fit is *said* to be missing in the text
 * the model reads, and the file stays readable with `read_file`. The hard refusals are untouched: a symlink, a
 * directory where a file should be, malformed UTF-8, an embedded NUL and a path outside the workspace are all
 * decided exactly as before, because none of them is a size question.
 */
export const INSTRUCTION_FILE_BYTES = 32 * 1024;
export const INSTRUCTION_TOTAL_BYTES = 64 * 1024;

export interface InstructionOmission {
  file: string;
  /** `truncated` kept a prefix of the file; `dropped` kept none of it. */
  kind: 'truncated' | 'dropped';
  /** The bytes that reached the prompt. Zero for a dropped file. */
  keptBytes: number;
}

export interface LoadedInstructions {
  text: string;
  /** Every instruction file the workspace contributes, in the order it is rendered. */
  files: string[];
  /** What the budget did to them. Empty when every file was rendered whole. */
  omissions: InstructionOmission[];
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function checkedDirectory(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  if (!inside(root, resolved)) throw new Error('Instruction target is outside workspace');
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    if (
      ['.git', '.yuantu', 'node_modules', '.ssh', '.aws', '.azure', '.gnupg'].includes(
        part.toLowerCase(),
      ) ||
      /^\.env(?:\.|$)/i.test(part)
    )
      throw new Error('Instruction target is an excluded directory');
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed for instructions');
  }
  const canonical = realpathSync(resolved);
  if (!inside(realpathSync(root), canonical))
    throw new Error('Resolved instruction target is outside workspace');
  if (!lstatSync(canonical).isDirectory())
    throw new Error('Instruction target must be a directory');
  return resolved;
}

/**
 * The longest prefix of `text` that fits in `budget` bytes, and its size.
 *
 * A binary search rather than a subtraction: the budget is in UTF-8 bytes and a JavaScript string is counted in
 * UTF-16 code units, so `slice(0, budget)` is not the same cut — and for the CJK instructions this is written
 * for it is off by a factor of three. A cut landing between the halves of a surrogate pair is pulled back one
 * code unit, because half a pair encodes as a replacement character and would put a corrupted glyph in the
 * middle of a prompt.
 */
function prefixBytes(text: string, budget: number): { text: string; bytes: number } {
  const whole = Buffer.byteLength(text, 'utf8');
  if (whole <= budget) return { text, bytes: whole };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= budget) low = middle;
    else high = middle - 1;
  }
  let cut = text.slice(0, low);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, bytes: Buffer.byteLength(cut, 'utf8') };
}

/** What the budget left out, said in the text the model reads rather than only in a log nobody opens. */
function budgetNotice(omissions: readonly InstructionOmission[]): string {
  const described = omissions.map((entry) =>
    entry.kind === 'dropped'
      ? `${entry.file} was left out entirely`
      : `${entry.file} was cut after ${entry.keptBytes} bytes`,
  );
  return (
    `[These instructions did not fit the ${INSTRUCTION_TOTAL_BYTES / 1024}KB a request carries ` +
    `(${INSTRUCTION_FILE_BYTES / 1024}KB per file, allocated from the file nearest the target outwards): ` +
    `${described.join('; ')}. The files are unchanged on disk — read them directly for the rest.]`
  );
}

export function loadInstructions(workspace: string, target = workspace): LoadedInstructions {
  const root = path.resolve(workspace);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error('Symbolic links are not allowed for workspace');
  if (!rootStat.isDirectory()) throw new Error('Workspace must be a directory');
  const directory = checkedDirectory(root, target);
  const relativeTarget = path.relative(root, directory);
  const directories = [root];
  let current = root;
  for (const part of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    directories.push(current);
  }
  const selected: { contents: string; file: string; name: string }[] = [];
  for (const candidateDirectory of directories) {
    const name = names.find((candidate) => existsSync(path.join(candidateDirectory, candidate)));
    if (!name) continue;
    const absolute = path.join(candidateDirectory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${name}`);
    if (!stat.isFile()) throw new Error(`Instruction source must be a regular file: ${name}`);
    if (!inside(realpathSync(root), realpathSync(absolute)))
      throw new Error(`Instruction source is outside workspace: ${name}`);
    const bytes = readFileSync(absolute);
    let contents: string;
    try {
      contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Instruction source must be UTF-8');
    }
    if (contents.includes('\0')) throw new Error('Instruction source must be UTF-8 text');
    selected.push({
      contents,
      file: path.relative(root, absolute).split(path.sep).join('/'),
      name,
    });
  }
  if (selected.length === 0) return { text: '', files: [], omissions: [] };
  /**
   * Spend the total budget from the nearest file outwards.
   *
   * Direction is the whole decision: the loader's own contract is that a file nearer the target wins a
   * conflict, so under a budget it must also win the room. Allocating root-first would keep the most general
   * instructions and drop the most specific ones, which is the opposite of what the ordering paragraph promises
   * the model. The rendered order stays root-first, because that is how the text explains itself.
   */
  const rendered = new Map<number, string>();
  const omissions: InstructionOmission[] = [];
  let remaining = INSTRUCTION_TOTAL_BYTES;
  for (let index = selected.length - 1; index >= 0; index--) {
    const candidate = selected[index]!;
    if (remaining <= 0) {
      // Nothing left at all: an outer file is dropped whole rather than kept as a fragment too short to use.
      // This is the "drop the outermost first" half of the rule the budget states.
      omissions.push({ file: candidate.file, kind: 'dropped', keptBytes: 0 });
      continue;
    }
    const allowance = Math.min(remaining, INSTRUCTION_FILE_BYTES);
    const cut = prefixBytes(candidate.contents, allowance);
    rendered.set(index, cut.text);
    remaining -= cut.bytes;
    if (cut.bytes < Buffer.byteLength(candidate.contents, 'utf8'))
      omissions.push({ file: candidate.file, kind: 'truncated', keptBytes: cut.bytes });
  }
  // The notice is written in the order a reader meets the files, not in the order the budget was spent.
  omissions.reverse();
  const header = [
    'Project instructions are ordered from the workspace root to the target. ' +
      'When instructions conflict, the file nearer the target takes priority.',
    ...(omissions.length ? [budgetNotice(omissions)] : []),
  ].join('\n\n');
  const blocks = selected
    .map((candidate, index) =>
      rendered.has(index)
        ? `===== BEGIN ${candidate.name} (source: ${candidate.file}) =====\n${rendered.get(index)}\n===== END ${candidate.name} =====`
        : undefined,
    )
    .filter((block): block is string => block !== undefined);
  return {
    files: selected.map(({ file }) => file),
    omissions,
    text: `${header}\n\n${blocks.join('\n\n')}`,
  };
}
