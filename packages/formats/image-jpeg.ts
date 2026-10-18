/** T.81 marker/container validation; entropy decoding remains the image consumer's responsibility. */
export function validateJpeg(bytes: Uint8Array): void {
  const invalid = (): never => {
    throw new Error('Invalid or damaged JPEG image');
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let frame = -1;
  let height = 0;
  let scans = 0;
  let restartInterval = 0;
  const components = new Set<number>();
  const quantization = new Set<number>();
  const huffman = new Set<number>();
  const frameTables = new Map<number, number>();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++] ?? invalid();
    if (marker === 0xd9) {
      if (frame < 0 || !height || !scans || offset !== bytes.length) invalid();
      return;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (marker === 1) continue; // TEM has no length field.
    if (offset + 2 > bytes.length) invalid();
    const length = view.getUint16(offset);
    const start = offset + 2;
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (frame >= 0 || length < 11) invalid();
      frame = marker;
      const precision = bytes[start]!;
      height = view.getUint16(start + 1);
      const count = bytes[start + 5]!;
      const lossless = (marker & 3) === 3;
      if (
        !view.getUint16(start + 3) ||
        !count ||
        length !== 8 + count * 3 ||
        (lossless ? precision < 2 || precision > 16 : ![8, 12].includes(precision)) ||
        (marker === 0xc0 && precision !== 8)
      )
        invalid();
      for (let at = start + 6; at < end; at += 3) {
        const id = bytes[at]!;
        const sampling = bytes[at + 1]!;
        const table = bytes[at + 2]!;
        if (
          components.has(id) ||
          !(sampling >> 4) ||
          sampling >> 4 > 4 ||
          !(sampling & 15) ||
          (sampling & 15) > 4 ||
          table > 3 ||
          (lossless && table !== 0)
        )
          invalid();
        components.add(id);
        frameTables.set(id, table);
      }
    } else if (marker === 0xdb) {
      let at = start;
      while (at < end) {
        const field = bytes[at++]!;
        if (field >> 4 > 1 || (field & 15) > 3) invalid();
        quantization.add(field & 15);
        at += 64 * ((field >> 4) + 1);
      }
      if (at !== end || start === end) invalid();
    } else if (marker === 0xc4) {
      let at = start;
      while (at < end) {
        const field = bytes[at++]!;
        if (field >> 4 > 1 || (field & 15) > 3 || at + 16 > end) invalid();
        let count = 0;
        let available = 1;
        for (let bit = 0; bit < 16; bit++) {
          const codes = bytes[at++]!;
          available = available * 2 - codes;
          if (available < 0) invalid();
          count += codes;
        }
        if (!count || count > 256 || at + count > end) invalid();
        at += count;
        huffman.add(field);
      }
      if (at !== end || start === end) invalid();
    } else if (marker === 0xdd) {
      if (length !== 4) invalid();
      restartInterval = view.getUint16(start);
    } else if (marker === 0xdc) {
      if (length !== 4 || !scans || height || !view.getUint16(start)) invalid();
      height = view.getUint16(start);
    } else if (marker === 0xda) {
      const count = bytes[start]!;
      if (frame < 0 || !count || count > 4 || length !== 6 + count * 2) invalid();
      const spectralStart = bytes[end - 3]!;
      const spectralEnd = bytes[end - 2]!;
      const approximation = bytes[end - 1]!;
      const lossless = (frame & 3) === 3;
      const progressive = (frame & 3) === 2;
      if (
        lossless
          ? spectralStart < 1 || spectralStart > 7 || spectralEnd !== 0 || approximation >> 4 !== 0
          : progressive
            ? spectralStart > spectralEnd ||
              spectralEnd > 63 ||
              (spectralStart === 0 && spectralEnd !== 0) ||
              (spectralStart > 0 && count !== 1) ||
              approximation >> 4 > 13 ||
              (approximation & 15) > 13 ||
              (approximation >> 4 !== 0 && approximation >> 4 !== (approximation & 15) + 1)
            : spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0
      )
        invalid();
      const selected = new Set<number>();
      for (let at = start + 1; at < end - 3; at += 2) {
        const id = bytes[at]!;
        const table = bytes[at + 1]!;
        if (!components.has(id) || selected.has(id) || table >> 4 > 3 || (table & 15) > 3)
          invalid();
        selected.add(id);
        if (!lossless && !quantization.has(frameTables.get(id)!)) invalid();
        if (!(frame & 8)) {
          // Huffman processes; arithmetic tables use DAC instead.
          if (
            (lossless || spectralStart === 0) &&
            !(progressive && approximation >> 4) &&
            !huffman.has(table >> 4)
          )
            invalid();
          if (!lossless && spectralEnd > 0 && !huffman.has(0x10 | (table & 15))) invalid();
        }
      }
      scans++;
      offset = end;
      let entropy = 0;
      let restart = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          entropy++;
          continue;
        }
        const markerStart = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          if (next !== 0) {
            if (!restartInterval || next !== 0xd0 + restart) invalid();
            restart = (restart + 1) % 8;
          }
          offset++;
          if (next === 0) entropy++;
          continue;
        }
        offset = markerStart;
        break;
      }
      if (!entropy) invalid();
      continue;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe && marker !== 0xcc) {
      invalid();
    }
    offset = end;
  }
  invalid();
}
