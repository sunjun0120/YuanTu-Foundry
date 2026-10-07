import JSZip from 'jszip';

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
  const presentation = await zip.file('ppt/presentation.xml')?.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
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
    const xml = await zip.file(name)!.async('string');
    if (xml.length > 2_000_000) throw new Error('PPTX slide XML is too large');
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
