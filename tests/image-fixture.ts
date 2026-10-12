import { crc32 } from 'node:zlib';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A valid one-pixel PNG with metadata large enough to exercise transport/history size boundaries. */
export function largePng(bytes: number): Buffer {
  const key = Buffer.from('fixture\0');
  const length = bytes - PIXEL.length - 12;
  if (!Number.isSafeInteger(bytes) || length < key.length)
    throw new Error('PNG fixture size is too small');
  const chunk = Buffer.alloc(length + 12, 120);
  chunk.writeUInt32BE(length);
  chunk.write('tEXt', 4, 4, 'ascii');
  key.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + length)), 8 + length);
  return Buffer.concat([PIXEL.subarray(0, 33), chunk, PIXEL.subarray(33)]);
}
