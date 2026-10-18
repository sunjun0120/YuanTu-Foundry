/** RIFF/WebP container and codec-header validation, without pixel decompression. */
export function validateWebp(bytes: Uint8Array): void {
  const invalid = (): never => {
    throw new Error('Invalid or damaged WebP image');
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(4, true) !== bytes.length - 8 || bytes.length % 2)
    invalid();
  const u24 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  const chunks = (start: number, end: number): { type: string; start: number; end: number }[] => {
    const result = [];
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) invalid();
      const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (
        length > end - data ||
        data + length + (length % 2) > end ||
        (length % 2 && bytes[data + length] !== 0)
      )
        invalid();
      result.push({ type, start: data, end: data + length });
      offset = data + length + (length % 2);
    }
    return result;
  };
  const codec = (
    type: string,
    start: number,
    end: number,
  ): { width: number; height: number; alpha: boolean | undefined } => {
    if (type === 'VP8 ') {
      if (end - start <= 10) invalid();
      const tag = u24(start);
      if (
        tag & 1 ||
        ((tag >> 1) & 7) > 3 ||
        !(tag & 16) ||
        !(tag >> 5) ||
        tag >> 5 > end - start - 10 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 1 ||
        bytes[start + 5] !== 0x2a
      )
        invalid();
      const width = view.getUint16(start + 6, true) & 0x3fff;
      const height = view.getUint16(start + 8, true) & 0x3fff;
      if (!width || !height) invalid();
      return { width, height, alpha: false };
    }
    if (type !== 'VP8L' || end - start <= 5 || bytes[start] !== 0x2f) invalid();
    const bits = view.getUint32(start + 1, true);
    if (bits >>> 29) invalid();
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      // alpha_is_used is only a hint: actual transparency requires pixel decoding.
      alpha: undefined,
    };
  };
  const alphaChunk = (start: number, end: number, width: number, height: number): void => {
    const flags = bytes[start]!;
    if (
      end - start <= 1 ||
      flags & 0xc0 ||
      (flags & 3) > 1 ||
      ((flags >> 4) & 3) > 1 ||
      (!(flags & 3) && end - start !== 1 + width * height)
    )
      invalid();
  };
  const list = chunks(12, bytes.length);
  const first = list[0] ?? invalid();
  const extended = first.type === 'VP8X';
  let flags = 0;
  let width = 0;
  let height = 0;
  if (extended) {
    const at = first.start;
    if (
      first.end - at !== 10 ||
      bytes[at]! & 0xc1 ||
      bytes[at + 1] ||
      bytes[at + 2] ||
      bytes[at + 3]
    )
      invalid();
    flags = bytes[at]!;
    width = u24(at + 4) + 1;
    height = u24(at + 7) + 1;
    if (width * height > 0xffffffff) invalid();
  } else if (!['VP8 ', 'VP8L'].includes(first.type)) invalid();
  let image = false;
  let alpha = false;
  let losslessAlphaUnknown = false;
  let animation = false;
  let frames = 0;
  let pendingAlpha: { start: number; end: number } | undefined;
  const metadata = new Set<string>();
  for (let index = extended ? 1 : 0; index < list.length; index++) {
    const { type, start, end } = list[index]!;
    if (type === 'VP8X') invalid();
    if (type === 'ICCP' || type === 'EXIF' || type === 'XMP ') {
      if (
        !extended ||
        metadata.has(type) ||
        start === end ||
        (type === 'ICCP' && (image || frames > 0 || animation || !!pendingAlpha))
      )
        invalid();
      metadata.add(type);
    } else if (type === 'ANIM') {
      if (!(flags & 2) || animation || image || frames || end - start !== 6) invalid();
      animation = true;
    } else if (type === 'ANMF') {
      if (!animation || end - start < 16 || bytes[start + 15]! & 0xfc) invalid();
      const frameWidth = u24(start + 6) + 1;
      const frameHeight = u24(start + 9) + 1;
      if (u24(start) * 2 + frameWidth > width || u24(start + 3) * 2 + frameHeight > height)
        invalid();
      let frameImage = false;
      let frameAlpha: { start: number; end: number } | undefined;
      for (const chunk of chunks(start + 16, end)) {
        if (chunk.type === 'ALPH') {
          if (frameAlpha || frameImage) invalid();
          alphaChunk(chunk.start, chunk.end, frameWidth, frameHeight);
          frameAlpha = chunk;
          alpha = true;
        } else if (chunk.type === 'VP8 ' || chunk.type === 'VP8L') {
          if (frameImage || (frameAlpha && chunk.type === 'VP8L')) invalid();
          const dimensions = codec(chunk.type, chunk.start, chunk.end);
          if (dimensions.width !== frameWidth || dimensions.height !== frameHeight) invalid();
          losslessAlphaUnknown ||= dimensions.alpha === undefined;
          frameImage = true;
        } else if (['VP8X', 'ANIM', 'ANMF', 'ICCP', 'EXIF', 'XMP '].includes(chunk.type)) invalid();
      }
      if (!frameImage) invalid();
      frames++;
    } else if (type === 'ALPH') {
      if (!extended || flags & 2 || image || pendingAlpha) invalid();
      alphaChunk(start, end, width, height);
      pendingAlpha = { start, end };
      alpha = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image || flags & 2 || (pendingAlpha && type === 'VP8L')) invalid();
      const dimensions = codec(type, start, end);
      if (extended && (width !== dimensions.width || height !== dimensions.height)) invalid();
      losslessAlphaUnknown ||= dimensions.alpha === undefined;
      image = true;
    }
  }
  if (flags & 2 ? !animation || !frames : !image) invalid();
  if (
    extended &&
    (!!(flags & 0x20) !== metadata.has('ICCP') ||
      (alpha && !(flags & 0x10)) ||
      (!alpha && !losslessAlphaUnknown && !!(flags & 0x10)) ||
      !!(flags & 8) !== metadata.has('EXIF') ||
      !!(flags & 4) !== metadata.has('XMP '))
  )
    invalid();
}
