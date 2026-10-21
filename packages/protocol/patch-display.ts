/**
 * Undo the ASCII-safe quoting a patch writer applies to file names.
 *
 * A unified diff is meant to survive a mailbox, so `diff` writes a non-ASCII name as a quoted string of octal
 * byte escapes: `+++ "\346\224\266\345\205\245\346\212\245\345\221\212.docx"`. That is correct for a patch file
 * and useless in an approval card — the person deciding whether to allow the write was shown exactly that line
 * for a file called `收入报告.docx`, and the actual name appeared nowhere on the card.
 *
 * The patch itself is not rewritten: it is what the tools produce and what `apply_patch` consumes. This is the
 * display pass, applied where a patch is painted for a person.
 */

/** `--- ` / `+++ ` header lines only; a content line that starts with `--` is not a file name. */
const HEADER = /^(?:--- |\+\+\+ )/u;
const OCTAL = /^[0-7]{3}$/u;
const ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The readable form of one (possibly quoted, possibly escaped) patch path. */
export function readablePatchPath(value: string): string {
  const name = value.trim();
  if (name.length < 2 || !name.startsWith('"') || !name.endsWith('"')) return name;
  const body = name.slice(1, -1);
  const chunks: Uint8Array[] = [];
  let plain = '';
  const flush = (): void => {
    if (!plain) return;
    chunks.push(encoder.encode(plain));
    plain = '';
  };
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character !== '\\') {
      plain += character;
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (OCTAL.test(octal)) {
      flush();
      chunks.push(Uint8Array.of(Number.parseInt(octal, 8)));
      index += 3;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) {
      plain += character;
      continue;
    }
    plain += ESCAPES[escaped] ?? escaped;
    index += 1;
  }
  flush();
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(bytes);
}

/** The patch as a person should read it: quoted header paths decoded, every other line untouched. */
export function readablePatchPaths(patch: string): string {
  if (!patch.includes('\\')) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (!HEADER.test(line)) return line;
      const marker = line.slice(0, 4);
      const rest = line.slice(4);
      // A header may carry a timestamp after a tab; the name is everything before it.
      const tab = rest.indexOf('\t');
      const name = tab === -1 ? rest : rest.slice(0, tab);
      const suffix = tab === -1 ? '' : rest.slice(tab);
      return marker + readablePatchPath(name) + suffix;
    })
    .join('\n');
}
