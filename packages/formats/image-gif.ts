/** GIF87a/89a block validation without decoding the LZW pixel stream. */
export function validateGif(bytes: Uint8Array): void {
  const invalid = (): never => {
    throw new Error('Invalid or damaged GIF image');
  };
  if (bytes.length < 14) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (!width || !height) invalid();
  let offset = 13;
  let images = 0;
  const skip = (length: number): void => {
    if (offset + length > bytes.length) invalid();
    offset += length;
  };
  const subBlocks = (): number => {
    let data = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++]!;
      if (!length) return data;
      skip(length);
      data += length;
    }
    return invalid();
  };
  if (bytes[10]! & 0x80) skip(3 * 2 ** ((bytes[10]! & 7) + 1));
  while (offset < bytes.length) {
    const block = bytes[offset++]!;
    if (block === 0x3b) {
      if (!images || offset !== bytes.length) invalid();
      return;
    }
    if (block === 0x2c) {
      if (offset + 9 > bytes.length) invalid();
      const left = view.getUint16(offset, true);
      const top = view.getUint16(offset + 2, true);
      const w = view.getUint16(offset + 4, true);
      const h = view.getUint16(offset + 6, true);
      const flags = bytes[offset + 8]!;
      if (!w || !h || left + w > width || top + h > height || flags & 0x18) invalid();
      offset += 9;
      if (flags & 0x80) skip(3 * 2 ** ((flags & 7) + 1));
      const codeSize = bytes[offset++] ?? 0;
      if (codeSize < 2 || codeSize > 8 || !subBlocks()) invalid();
      images++;
    } else if (block === 0x21) {
      const label = bytes[offset++];
      if (label === undefined) invalid();
      if (label === 0xf9) {
        if (
          bytes[offset++] !== 4 ||
          offset + 5 > bytes.length ||
          bytes[offset]! & 0xe0 ||
          ((bytes[offset]! >> 2) & 7) > 3
        )
          invalid();
        skip(4);
        if (bytes[offset++] !== 0) invalid();
      } else {
        if (label === 0xff || label === 1) {
          const length = label === 0xff ? 11 : 12;
          if (bytes[offset++] !== length) invalid();
          skip(length);
        }
        subBlocks(); // Comments and unknown extensions retain their sub-block framing.
      }
    } else invalid();
  }
  invalid();
}
