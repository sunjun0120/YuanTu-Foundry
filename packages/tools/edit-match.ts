/**
 * Where one `old_text` → `new_text` replacement lands in a file's text, or why it cannot.
 *
 * Exact and unique, as before; two things are added around that. A CRLF file reads back without its carriage
 * returns (`read_file` presents lines), so the multi-line `old_text` a model copies from it never matched: when the
 * exact text is absent, the same text with CRLF breaks is tried, and the replacement takes the file's breaks too.
 * Uniqueness is still checked on what is actually replaced, so this cannot land anywhere the exact rule would not.
 * And a refusal says which refusal it is — nothing matched, or several places did — with line numbers, because
 * "must match exactly once" reads as "guess again", and the guesses were what cost the rounds.
 */
export interface EditMatch {
  index: number;
  oldText: string;
  newText: string;
}

/** Enough line numbers to act on; past this the model needs a longer `old_text`, not a longer list. */
const MAX_LISTED = 5;
const MAX_QUOTED = 80;

export function matchEdit(source: string, oldText: string, newText: string): EditMatch {
  const exact = occurrences(source, oldText);
  if (exact.length === 1) return { index: exact[0]!, oldText, newText };
  if (
    !exact.length &&
    !oldText.includes('\r') &&
    oldText.includes('\n') &&
    source.includes('\r\n')
  ) {
    const crlfOld = oldText.replaceAll('\n', '\r\n');
    const crlf = occurrences(source, crlfOld);
    const crlfNew = newText.includes('\r') ? newText : newText.replaceAll('\n', '\r\n');
    if (crlf.length === 1) return { index: crlf[0]!, oldText: crlfOld, newText: crlfNew };
    if (crlf.length > 1) throw new Error(ambiguous(source, crlf));
  }
  if (exact.length > 1) throw new Error(ambiguous(source, exact));
  throw new Error(missing(source, oldText));
}

function occurrences(source: string, text: string): number[] {
  const found: number[] = [];
  for (let index = source.indexOf(text); index >= 0; index = source.indexOf(text, index + 1))
    found.push(index);
  return found;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let at = source.indexOf('\n'); at >= 0 && at < index; at = source.indexOf('\n', at + 1))
    line++;
  return line;
}

function listed(lines: number[]): string {
  const shown = lines.slice(0, MAX_LISTED).join(', ');
  return lines.length > MAX_LISTED ? `${shown}, …` : shown;
}

function ambiguous(source: string, found: number[]): string {
  const lines = found.map((index) => lineOf(source, index));
  return (
    `old_text matches ${String(found.length)} times (lines ${listed(lines)}); ` +
    'add surrounding lines until it matches exactly once'
  );
}

function missing(source: string, oldText: string): string {
  const first = oldText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const lines: number[] = [];
  if (first)
    source.split(/\r?\n/).forEach((line, index) => {
      if (line.trim() === first) lines.push(index + 1);
    });
  if (!lines.length)
    return 'old_text was not found, and its first line matches no line of the file: re-read the file before editing';
  const quoted = first!.length > MAX_QUOTED ? `${first!.slice(0, MAX_QUOTED)}…` : first!;
  return (
    `old_text was not found. Its first line ("${quoted}") appears at line ${listed(lines)}, but the text after ` +
    'it differs (often whitespace or indentation): re-read those lines and copy them exactly'
  );
}
