import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { OfficeOperation } from './automation.ts';
import { xmlText } from './xml-text.ts';
import { assertExpansionWithinBudget, readEntry } from './zip-entry.ts';

type Replacement = { from: string; to: string };

/** Ceilings for the parts this module rewrites, in uncompressed bytes, applied while each part is read. */
const PART_BYTES = 16_000_000;
const PACKAGE_BYTES = 48_000_000;

/**
 * Which parts hold editable text and how their paragraphs and text nodes are spelled.
 *
 * Word keeps body text in the document part and in headers, footers, footnotes and endnotes; PowerPoint keeps
 * it per slide. Speaker notes are left alone, as the COM path this replaced also left them.
 */
const DIALECTS = {
  docx: {
    parts: /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
    paragraph: 'w:p',
    text: 'w:t',
  },
  pptx: { parts: /^ppt\/slides\/slide\d+\.xml$/, paragraph: 'a:p', text: 'a:t' },
} as const;

const decode = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower]!;
  });
/** Replacement text comes from the model, so characters XML forbids are dropped before it is escaped. */
const encode = (value: string): string =>
  xmlText(value).replace(
    /[&<>]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!,
  );

/** One text node: where its content sits in the part, and its decoded text, which replacements rewrite. */
type TextNode = { open: string; start: number; end: number; text: string; changed: boolean };

/**
 * The text nodes of a part, grouped by the innermost paragraph that contains them.
 *
 * Paragraphs nest — a Word text box puts whole paragraphs inside a run of another — so grouping follows a stack
 * of open paragraph tags instead of matching `<w:p>…</w:p>` pairs, which would cut the outer paragraph at the
 * inner one's end. A text node outside any paragraph is its own group.
 */
function paragraphs(xml: string, paragraph: string, text: string): TextNode[][] {
  const token = new RegExp(
    `<${paragraph}(?=[\\s>/])[^>]*?(/?)>|</${paragraph}>|<${text}(\\s[^>]*)?>([^<]*)</${text}>`,
    'g',
  );
  const groups: TextNode[][] = [];
  const stack: TextNode[][] = [];
  for (const match of xml.matchAll(token)) {
    const whole = match[0];
    if (whole.startsWith(`</${paragraph}>`)) {
      const done = stack.pop();
      if (done?.length) groups.push(done);
    } else if (whole.startsWith(`<${paragraph}`) && !whole.startsWith(`<${text}`)) {
      if (match[1] !== '/') stack.push([]);
    } else {
      const open = `<${text}${match[2] ?? ''}>`;
      const start = match.index + open.length;
      const node = {
        open,
        start,
        end: start + match[3]!.length,
        text: decode(match[3]!),
        changed: false,
      };
      if (stack.length) stack[stack.length - 1]!.push(node);
      else groups.push([node]);
    }
  }
  for (const open of stack) if (open.length) groups.push(open);
  return groups;
}

/**
 * Replace every occurrence of `from` in one paragraph, including occurrences split across runs.
 *
 * Editors split a sentence into runs wherever formatting, spell-check state or revision history changes, so the
 * text a reader sees as one phrase is often several nodes. The paragraph is searched as one string; a match is
 * written into the node where it starts, so the replacement takes that run's formatting, and the matched text
 * is removed from the following nodes it spilled into.
 */
function replaceInParagraph(nodes: TextNode[], from: string, to: string): number {
  let count = 0;
  let searchFrom = 0;
  for (;;) {
    const joined = nodes.map((node) => node.text).join('');
    const at = joined.indexOf(from, searchFrom);
    if (at < 0) return count;
    const end = at + from.length;
    let offset = 0;
    let first = -1;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const nodeStart = offset;
      const nodeEnd = offset + node.text.length;
      offset = nodeEnd;
      if (nodeEnd <= at) continue;
      if (nodeStart >= end) break;
      const keepBefore = node.text.slice(0, Math.max(0, at - nodeStart));
      const keepAfter = nodeEnd > end ? node.text.slice(end - nodeStart) : '';
      node.text = keepBefore + (first < 0 ? to : '') + keepAfter;
      node.changed = true;
      if (first < 0) first = index;
    }
    count++;
    searchFrom = at + to.length;
  }
}

/** Write changed nodes back, last first so earlier offsets stay valid; changed nodes preserve spaces. */
function rewrite(xml: string, nodes: TextNode[]): string {
  const changed = nodes.filter((node) => node.changed).sort((a, b) => b.start - a.start);
  for (const node of changed) {
    const open = node.open.includes('xml:space=')
      ? node.open
      : node.open.replace(/>$/, ' xml:space="preserve">');
    xml =
      xml.slice(0, node.start - node.open.length) + open + encode(node.text) + xml.slice(node.end);
  }
  return xml;
}

/**
 * Template edits for Word and PowerPoint without Microsoft Office.
 *
 * Only the text of matching nodes changes; every other part and every other byte of a rewritten part is kept,
 * so styles, layout, images and fields that do not contain the text are untouched. A replacement that matches
 * nothing anywhere is an error, as it was under the COM path: a template edit that silently did nothing is
 * worse than one that stops.
 */
export async function replaceOfficeText(
  operation: Extract<OfficeOperation, { operation: 'edit' }> & { format: 'docx' | 'pptx' },
): Promise<void> {
  const replacements: Replacement[] = operation.replacements ?? [];
  if (!replacements.length) throw new Error('Word or PowerPoint edit requires replacements');
  const source = await readFile(operation.sourcePath);
  if (source.length > 20_000_000) throw new Error('Office template exceeds 20 MB');
  const zip = await JSZip.loadAsync(source);
  await assertExpansionWithinBudget(
    zip,
    { part: PART_BYTES, total: PACKAGE_BYTES },
    operation.format.toUpperCase() + ' package',
  );
  const dialect = DIALECTS[operation.format];
  const names = Object.keys(zip.files)
    .filter((name) => dialect.parts.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!names.length) throw new Error(`Invalid ${operation.format.toUpperCase()} package`);
  const found = new Array<number>(replacements.length).fill(0);
  for (const name of names) {
    const xml = (await readEntry(zip.file(name), PART_BYTES, `${operation.format} part ${name}`))!;
    const groups = paragraphs(xml, dialect.paragraph, dialect.text);
    replacements.forEach(({ from, to }, index) => {
      for (const nodes of groups) found[index]! += replaceInParagraph(nodes, from, to);
    });
    const all = groups.flat();
    if (all.some((node) => node.changed)) zip.file(name, rewrite(xml, all));
  }
  const missing = replacements.filter((_, index) => !found[index]);
  if (missing.length)
    throw new Error(
      `${operation.format === 'docx' ? 'Word' : 'PowerPoint'} text not found: ${missing.map((item) => item.from).join(', ')}`,
    );
  await writeFile(
    operation.outputPath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
}
