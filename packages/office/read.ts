import JSZip from 'jszip';
import { readEntry } from './zip-entry.ts';

/**
 * Per-part ceilings, in uncompressed bytes.
 *
 * Each is far above anything a real package holds — the presentation part is kilobytes and a slide part tens of
 * kilobytes — and far below the 20 MB package limit, so a bomb is refused without a document being.
 */
const PRESENTATION_XML_BYTES = 2_000_000;
const RELATIONSHIP_XML_BYTES = 1_000_000;
const SLIDE_XML_BYTES = 2_000_000;

const decodeXml = (value: string): string =>
  value.replace(
    /&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,
    (_, number: string, named: string) => {
      if (number) {
        const code =
          number[0]?.toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
          named.toLowerCase()
        ] ?? ''
      );
    },
  );

export async function readPptxSlides(bytes: Buffer): Promise<string[]> {
  if (bytes.length > 20_000_000) throw new Error('PPTX exceeds 20 MB');
  const zip = await JSZip.loadAsync(bytes);
  const presentation = await readEntry(
    zip.file('ppt/presentation.xml'),
    PRESENTATION_XML_BYTES,
    'PPTX presentation XML',
  );
  const rels = await readEntry(
    zip.file('ppt/_rels/presentation.xml.rels'),
    RELATIONSHIP_XML_BYTES,
    'PPTX relationship XML',
  );
  if (!presentation || !rels) throw new Error('Invalid PPTX presentation relationships');
  const slideTargets = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*\/?\s*>/g) ?? []) {
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target) continue;
    const name = target.startsWith('/') ? target.slice(1) : 'ppt/' + target;
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slideTargets.set(id, name);
  }
  const entries = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)]
    .map((match) => slideTargets.get(match[1]!))
    .filter((name): name is string => !!name && !!zip.file(name));
  if (!entries.length || entries.length > 200) throw new Error('PPTX must contain 1 to 200 slides');
  const slides: string[] = [];
  let total = 0;
  for (const name of entries) {
    // The bound is applied while the part is read, so an oversized slide is refused before it is in memory.
    const xml = (await readEntry(zip.file(name), SLIDE_XML_BYTES, 'PPTX slide XML'))!;
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1]!))
      .join(' ')
      .trim();
    total += text.length;
    if (total > 60_000) throw new Error('PPTX text exceeds 60000 characters');
    slides.push(text);
  }
  return slides;
}
