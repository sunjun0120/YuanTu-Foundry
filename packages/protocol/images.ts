import type { ImageAttachment, ImageReference, UserInput } from './index.ts';
import { validatePng } from '../formats/image-png.ts';
import { validateJpeg } from '../formats/image-jpeg.ts';
import { validateGif } from '../formats/image-gif.ts';
import { validateWebp } from '../formats/image-webp.ts';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/**
 * Whether a stored image is a content address rather than the bytes themselves.
 *
 * The two shapes coexist on purpose: rows written before schema v21 carry `data` inline, and they are read as
 * they are rather than migrated. Told apart by `hash` and the absence of `data`, so a reader that meets either
 * shape — the store, a test, a person with `sqlite3` — classifies it the same way.
 */
export function isImageReference(value: unknown): value is ImageReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.hash === 'string' &&
    record.hash.length > 0 &&
    typeof record.mimeType === 'string' &&
    !('data' in record)
  );
}
/**
 * What kind of image these bytes are, or `null` if they are not one.
 *
 * One implementation for both callers: a user's attachment arrives already labelled, and a file read from the
 * workspace arrives with nothing but a name — an extension is a claim about content, and a `.png` that is
 * really a JPEG is rejected by the endpoint on the *next* request, one step away from the file that caused it.
 * Sniffing both through the same function is what keeps the tool and the validator from disagreeing about what
 * an image is. Byte comparison rather than `Buffer`, so the renderer can use it too.
 */
export function sniffImageType(bytes: Uint8Array): ImageAttachment['mimeType'] | null {
  const at = (index: number): number => bytes[index] ?? -1;
  const ascii = (start: number, text: string): boolean =>
    [...text].every((char, offset) => at(start + offset) === char.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}
/** The first bytes a base64 string decodes to, for signature checks that must not depend on the platform. */
function base64Head(data: string, bytes: number): Uint8Array {
  const decoded = atob(data.slice(0, Math.ceil(bytes / 3) * 4));
  const head = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) head[index] = decoded.charCodeAt(index);
  return head;
}
export function validateImages(input: unknown): ImageAttachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 4) throw new Error('At most 4 images are allowed');
  let total = 0;
  return input.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid image');
    const { data, mimeType, name } = value as Record<string, unknown>;
    if (typeof data !== 'string' || !data.length) throw new Error('Image base64 data is required');
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new Error('Image exceeds 5MB size limit');
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw new Error('Invalid image base64');
    // Browser-compatible decoding also keeps this validator usable in the renderer.
    if (sniffImageType(base64Head(data, 12)) !== mimeType)
      throw new Error('Unsupported image type or invalid image signature');
    const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    total += bytes;
    if (bytes > MAX_IMAGE_BYTES || total > 10 * 1024 * 1024)
      throw new Error('Image size exceeds 5MB per image or 10MB total');
    const validators = {
      'image/png': validatePng,
      'image/jpeg': validateJpeg,
      'image/gif': validateGif,
      'image/webp': validateWebp,
    };
    const decoded = atob(data);
    validators[mimeType as ImageAttachment['mimeType']](
      Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    );
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length > 256 || /[\x00-\x1f]/.test(name))
    )
      throw new Error('Invalid image name');
    return {
      data,
      mimeType: mimeType as ImageAttachment['mimeType'],
      ...(name ? { name: name as string } : {}),
    };
  });
}
export function validateUserInput(input: UserInput): UserInput {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100_000)
    throw new Error('Prompt must contain 1 to 100000 characters');
  const images = validateImages(input.images);
  return { prompt: input.prompt, ...(images.length ? { images } : {}) };
}
const sizedReplacer = (key: string, value: unknown): unknown =>
  key === 'change'
    ? undefined
    : key === 'images' && Array.isArray(value)
      ? value.map((i) => ({ mimeType: i.mimeType, name: i.name, data: '[image]'.repeat(512) }))
      : value;
/**
 * Each message's serialised length, keyed by the message object.
 *
 * The context budget asks this of the whole conversation on every request and again for every candidate cut while
 * compacting, and a long session is megabytes of JSON each time. Messages are immutable by the same convention
 * `packages/core/context/budget.ts` already relies on for its byte sizes (the store's fold is handed out as-is, and every
 * transformation builds a new message), so identity is a sound key and a `WeakMap` lets the entries go with them.
 */
const messageChars = new WeakMap<object, number>();
function elementChars(value: unknown): number {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value ?? null).length;
  const cached = messageChars.get(value);
  if (cached !== undefined) return cached;
  // `undefined` would be `null` inside an array, and a message is never one, but the sum must still match.
  const chars = (JSON.stringify(value, sizedReplacer) ?? 'null').length;
  messageChars.set(value, chars);
  return chars;
}
/**
 * The length of `JSON.stringify(messages)` under the sizing rules above, without building the string.
 *
 * An array is summed from its elements: `[`, the elements joined by `,`, and `]` — the same characters the whole
 * serialisation would produce, since the replacer never sees an array index as `change` or `images`.
 */
export function contextMessageSize(messages: unknown): number {
  if (!Array.isArray(messages)) return JSON.stringify(messages, sizedReplacer).length;
  let chars = 2 + Math.max(0, messages.length - 1);
  for (const message of messages) chars += elementChars(message);
  return chars;
}
