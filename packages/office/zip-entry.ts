import type JSZip from 'jszip';

/**
 * Reading one part out of an OOXML package without trusting the package about how big it is.
 *
 * An OOXML file is a zip, and every size a zip states about itself — the compressed length, and the uncompressed
 * length in the central directory — was written by whoever built the file. A part that declares itself small and
 * inflates to gigabytes is the ordinary shape of a decompression bomb, so the bound here is applied to the bytes
 * as they arrive rather than to a `.length` on a string that is already in memory. The checks this replaces ran
 * after `async('string')` had inflated the whole part, which is the one moment a size check cannot help: by then
 * the cost of finding out has already been paid by the process holding the result.
 *
 * Leaving the stream part-way is what makes the bound worth having — the rest of an oversized part is never
 * inflated at all — and it is why this reads `nodeStream()` rather than any of the forms that return a buffer.
 * The declared uncompressed size is deliberately not consulted: it would be cheaper, and it is the number the
 * attacker writes.
 *
 * `null` means the package has no such part, which callers distinguish from an empty one.
 */
/**
 * Stream one part, counting its bytes and stopping the moment it goes past `limit`.
 *
 * `keep` decides whether the bytes are collected or only counted: the caller that decodes a part needs them, the
 * caller pricing a whole package does not, and both need the same guarantee — the stream is destroyed on the way
 * out, so the rest of an oversized part is never inflated at all.
 */
async function pump(
  entry: JSZip.JSZipObject,
  limit: number,
  what: string,
  keep: boolean,
): Promise<{ bytes: number; chunks: Buffer[] }> {
  /**
   * Read through events rather than `for await`.
   *
   * `nodeStream()` returns jszip's own `readable-stream` v2 adapter, not a core one, so it carries no
   * `Symbol.asyncIterator` even though the declared type says it does — `for await` compiles and then fails at
   * run time. `'nodebuffer'` is the chunk type `Buffer.concat` wants.
   */
  const stream = entry.nodeStream('nodebuffer');
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > limit) {
        exceeded = true;
        /**
         * Destroying the adapter stops it resuming its helper, so the rest of an oversized part is never
         * inflated — without this the bound would only decide what is *kept*, not what is *produced*.
         *
         * The cast is narrow on purpose: the declared return type is a web `ReadableStream`, which has no
         * `destroy`, while the value is jszip's `readable-stream` v2 adapter, which does. If a future version
         * drops it the call is skipped and the bound still holds, because the handler above stops collecting.
         */
        (stream as unknown as { destroy?: () => void }).destroy?.();
        resolve();
        return;
      }
      if (keep) chunks.push(chunk);
    });
    stream.on('end', () => resolve());
    stream.on('error', (error: Error) => {
      if (!exceeded) reject(error);
    });
  });
  if (exceeded) throw new Error(`${what} is too large (over ${limit} bytes uncompressed)`);
  return { bytes, chunks };
}

export async function readEntry(
  entry: JSZip.JSZipObject | null | undefined,
  limit: number,
  what: string,
): Promise<string | null> {
  if (!entry) return null;
  const { chunks } = await pump(entry, limit, what, true);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Price a whole package before a library that has no bound of its own reads it.
 *
 * `readEntry` bounds the parts this repository reads itself, but `office_inspect` hands DOCX and XLSX packages to
 * mammoth and SheetJS, and neither of those consults a limit while inflating. Which parts they touch is their
 * business, so the bound cannot be a whitelist of known parts: every entry is streamed and counted, each one
 * capped on its own and all of them against one budget. A package that would inflate past either ceiling is
 * refused before the library sees it, and each stream is destroyed as its ceiling is crossed — so the refusal
 * costs the budget rather than the bomb.
 */
export async function assertExpansionWithinBudget(
  zip: JSZip,
  limits: { part: number; total: number },
  what: string,
): Promise<void> {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const remaining = limits.total - total;
    if (remaining <= 0) throw new Error(`${what} expands past ${limits.total} bytes uncompressed`);
    const cap = Math.min(limits.part, remaining);
    let bytes: number;
    try {
      bytes = (await pump(entry, cap, `${what} part ${entry.name}`, false)).bytes;
    } catch (error) {
      // A part stopped by the shared budget rather than by its own ceiling is a statement about the package.
      if (cap < limits.part)
        throw new Error(`${what} expands past ${limits.total} bytes uncompressed`);
      throw error;
    }
    total += bytes;
  }
}
