/** PNG container integrity only; pixel decompression remains the image consumer's responsibility. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** Validate required chunks, header fields, ordering and checksums without allocating pixel buffers. */
export function validatePng(bytes: Uint8Array): void {
  const invalid = (): never => {
    throw new Error('Invalid or damaged PNG image');
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header = false;
  let palette = false;
  let color = -1;
  let depth = -1;
  let imageBytes = 0;
  let dataStarted = false;
  let dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    const data = offset + 8;
    const end = data + length;
    let crc = 0xffffffff;
    for (let at = offset + 4; at < end; at++)
      crc = CRC_TABLE[(crc ^ bytes[at]!) & 0xff]! ^ (crc >>> 8);
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end)) invalid();
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      const width = view.getUint32(data);
      const height = view.getUint32(data + 4);
      depth = bytes[data + 8]!;
      color = bytes[data + 9]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !width ||
        !height ||
        width > 0x7fffffff ||
        height > 0x7fffffff ||
        !depths[color]?.includes(depth) ||
        bytes[data + 10] !== 0 ||
        bytes[data + 11] !== 0 ||
        bytes[data + 12]! > 1
      )
        invalid();
      header = true;
    } else if (type === 'PLTE') {
      if (
        palette ||
        dataStarted ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        color === 0 ||
        color === 4 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) invalid();
      dataStarted = true;
      imageBytes += length;
    } else if (type === 'IEND') {
      if (length || !imageBytes || end + 4 !== bytes.length) invalid();
      return;
    } else {
      if (type[0] === type[0]!.toUpperCase()) invalid(); // Unknown critical chunk.
    }
    if (dataStarted && type !== 'IDAT') dataEnded = true;
    offset = end + 4;
  }
  invalid();
}
