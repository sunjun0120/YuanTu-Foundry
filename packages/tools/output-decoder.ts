import { execFileSync } from 'node:child_process';

/**
 * Turns a child process's output bytes into text without mangling either of the two things that used to break it.
 *
 * A chunk boundary can fall inside a multi-byte character. Decoding every chunk on its own turned both halves into
 * U+FFFD, so a long Chinese build log carried a replacement glyph wherever the pipe happened to split it. Bytes of an
 * unfinished UTF-8 sequence are therefore carried into the next chunk.
 *
 * On Windows, console programs write in the OEM code page, not UTF-8: `cmd.exe` on a Chinese system says
 * 系统找不到指定的路径。 in GBK, and decoding that as UTF-8 handed the model mojibake for exactly the messages that
 * explain a failure. Modern tools (Node, Git, most compilers) write UTF-8, so the stream starts as UTF-8 and switches
 * to the OEM code page at the first byte sequence that is not valid UTF-8. A legacy-encoded stream that is ASCII up to
 * that point decodes identically either way, which is what makes the late switch safe.
 */
export interface OutputDecoder {
  write(chunk: Buffer): string;
  end(): string;
}

/** WHATWG encoding labels for the OEM code pages `TextDecoder` can decode. */
const OEM_ENCODINGS: Record<number, string> = {
  866: 'ibm866',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  54936: 'gb18030',
};

let oemEncoding: string | null | undefined;

/** The console code page as a `TextDecoder` label, or null when it is unknown or not decodable. Read once. */
export function windowsOemEncoding(): string | null {
  if (oemEncoding !== undefined) return oemEncoding;
  oemEncoding = null;
  try {
    const text = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const page = Number(/OEMCP\s+REG_SZ\s+(\d+)/.exec(text)?.[1]);
    oemEncoding = OEM_ENCODINGS[page] ?? null;
  } catch {
    oemEncoding = null;
  }
  return oemEncoding;
}

/** How many trailing bytes of `data` start a UTF-8 sequence that the next chunk has to finish. */
function incompleteTail(data: Buffer): number {
  for (let back = 1; back <= Math.min(3, data.length); back++) {
    const byte = data[data.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** Non-ASCII bytes that must decode as UTF-8 before a stream is trusted to be UTF-8 rather than a legacy page. */
const DECIDE_AFTER_BYTES = 16;
/** Held text is decided once it is this large, so an undecided stream never buffers without bound. */
const DECIDE_HOLD_LIMIT = 4096;

function validUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A decoder for one output stream.
 *
 * `legacy` is the encoding to fall back to; it defaults to the OEM code page on Windows and to none elsewhere, where
 * invalid bytes simply become U+FFFD as they always did.
 *
 * With a fallback available, text is held from the first non-ASCII byte until the encoding is clear: a short run of
 * GBK can be valid UTF-8 by accident (`cf b5`, the first half of 系, is the UTF-8 for ϵ), so the stream is called
 * UTF-8 only after {@link DECIDE_AFTER_BYTES} non-ASCII bytes decoded cleanly, and legacy at the first that did not.
 */
export function createOutputDecoder(
  legacy: string | null | (() => string | null) = process.platform === 'win32'
    ? windowsOemEncoding
    : null,
): OutputDecoder {
  let mode: 'undecided' | 'utf8' | 'legacy' = 'undecided';
  let pending: Buffer = Buffer.alloc(0);
  let fallback: TextDecoder | undefined;
  const legacyDecoder = (): TextDecoder | undefined => {
    if (fallback) return fallback;
    const label = typeof legacy === 'function' ? legacy() : legacy;
    if (!label) return undefined;
    try {
      return (fallback = new TextDecoder(label));
    } catch {
      return undefined;
    }
  };
  /** Decode `data` as UTF-8, keeping an unfinished trailing sequence for the next chunk. */
  const utf8 = (data: Buffer): string => {
    const keep = incompleteTail(data);
    pending = Buffer.from(data.subarray(data.length - keep));
    return data.subarray(0, data.length - keep).toString('utf8');
  };
  const toLegacy = (data: Buffer): string | undefined => {
    const decoder = legacyDecoder();
    if (!decoder) return undefined;
    mode = 'legacy';
    pending = Buffer.alloc(0);
    return decoder.decode(data, { stream: true });
  };
  const decide = (data: Buffer, final: boolean): string => {
    const firstWide = data.findIndex((byte) => byte >= 0x80);
    if (firstWide < 0) {
      pending = Buffer.alloc(0);
      return data.toString('latin1');
    }
    // The code page is only looked up once a stream has something it could matter for.
    if (!legacyDecoder()) {
      mode = 'utf8';
      if (!final) return utf8(data);
      pending = Buffer.alloc(0);
      return data.toString('utf8');
    }
    const keep = final ? 0 : incompleteTail(data);
    const complete = data.subarray(0, data.length - keep);
    if (!validUtf8(complete)) {
      const text = toLegacy(data);
      if (text !== undefined) return text;
      mode = 'utf8';
      return final ? data.toString('utf8') : utf8(data);
    }
    let wide = 0;
    for (const byte of complete) if (byte >= 0x80) wide++;
    if (final || wide >= DECIDE_AFTER_BYTES || data.length >= DECIDE_HOLD_LIMIT) {
      mode = 'utf8';
      if (final) {
        pending = Buffer.alloc(0);
        return data.toString('utf8');
      }
      return utf8(data);
    }
    // Still ambiguous: hand out the ASCII before the first wide byte and hold the rest.
    pending = Buffer.from(data.subarray(firstWide));
    return data.subarray(0, firstWide).toString('latin1');
  };
  return {
    write(chunk) {
      if (mode === 'legacy') return fallback!.decode(chunk, { stream: true });
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === 'undecided') return decide(data, false);
      const keep = incompleteTail(data);
      // A program that switches to its console code page mid-stream is still read in it from there on.
      if (fallback && !validUtf8(data.subarray(0, data.length - keep))) {
        const text = toLegacy(data);
        if (text !== undefined) return text;
      }
      return utf8(data);
    },
    end() {
      if (mode === 'legacy') return fallback!.decode();
      const rest = pending;
      pending = Buffer.alloc(0);
      if (!rest.length) return '';
      if (mode === 'undecided') return decide(rest, true) + (fallback?.decode() ?? '');
      return rest.toString('utf8');
    },
  };
}
