import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for the model-facing network tools.
 *
 * A literal hostname blocklist is not enough: `169.254.169.254.nip.io`, a single 302, or a
 * DNS record that points at a private address all defeat it. Every http/https target supplied by
 * the model is therefore resolved and every returned address is range-checked, and redirects are
 * re-checked at each hop (see `requestText` in web.ts and the route interception in browser.ts).
 *
 * Intentional exception: **loopback (127.0.0.0/8, ::1) is allowed**. Local development servers and
 * a locally run search gateway are supported uses, the tool requires an explicit per-call
 * "external" approval that displays the full URL, and reading a local service does not reach the
 * cloud metadata endpoints or the surrounding LAN. Set `YUANTU_ALLOW_PRIVATE_NETWORK=1` to also
 * permit private, link-local and unique-local ranges when the operator deliberately targets an
 * internal service; the metadata hostnames below stay blocked either way.
 *
 * Residual risk, stated honestly: the address is validated and then `fetch` resolves it again when
 * it connects, so a DNS answer that changes between those two moments (DNS rebinding) is not
 * closed by this check.
 */
const ALWAYS_BLOCKED = new Set([
  // Instance metadata service addresses and the names that only ever refer to one. These stay
  // blocked even when YUANTU_ALLOW_PRIVATE_NETWORK=1 lifts the range checks.
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.internal',
]);

/** Operator opt-in for internal targets; the metadata hostnames stay blocked regardless. */
export function privateNetworkAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUANTU_ALLOW_PRIVATE_NETWORK === '1';
}

/** Normalizes the forms a URL can carry: `[::1]` keeps its brackets, `metadata.google.internal.` a dot. */
export function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

function ipv4Reason(address: string): string | null {
  const parts = address.split('.');
  if (parts.length !== 4) return 'a malformed address';
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    return 'a malformed address';
  const [a, b, c] = numbers as [number, number, number, number];
  // Loopback is deliberately permitted; see the module comment.
  if (a === 127) return null;
  if (a === 0) return 'an unspecified address';
  if (a === 10) return 'a private network address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
  if (a === 169 && b === 254) return 'a link-local address (cloud metadata range)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private network address';
  if (a === 192 && b === 168) return 'a private network address';
  if (a === 192 && b === 88) return 'the 6to4 relay anycast range';
  if (a === 198 && (b === 18 || b === 19)) return 'a benchmarking range';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'an IETF or TEST-NET range';
  if (a === 198 && b === 51 && c === 100) return 'a TEST-NET range';
  if (a === 203 && b === 0 && c === 113) return 'a TEST-NET range';
  if (a >= 224) return 'a multicast, reserved or broadcast address';
  return null;
}

/** Expands an IPv6 literal to eight hextets, folding any embedded IPv4 form. */
function ipv6Hextets(address: string): number[] | null {
  let value = address.split('%')[0]!.toLowerCase();
  const embedded = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (embedded) {
    const octets = embedded[2]!.split('.').map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    value = `${embedded[1]}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((hextet) => Number.parseInt(hextet, 16)) : [];
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head.some((hextet) => !Number.isInteger(hextet)) || tail.some((h) => !Number.isInteger(h)))
    return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function ipv6Reason(address: string): string | null {
  const hextets = ipv6Hextets(address);
  if (!hextets) return 'a malformed address';
  const h0 = hextets[0]!;
  const h1 = hextets[1]!;
  const h6 = hextets[6]!;
  const h7 = hextets[7]!;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) carry a v4 address that must be
  // judged by v4 rules — this is the classic way to smuggle 127.0.0.1 past an IPv6 check.
  const mapped = hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff;
  const compatible = hextets.slice(0, 6).every((value) => value === 0);
  if (mapped || compatible) {
    if (h6 === 0 && h7 === 0) return 'an unspecified address';
    // ::1 is IPv6 loopback and is permitted on the same basis as 127.0.0.1/8.
    if (h6 === 0 && h7 === 1) return null;
    return ipv4Reason(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
  }
  if ((h0 & 0xfe00) === 0xfc00) return 'a unique-local address';
  if ((h0 & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((h0 & 0xff00) === 0xff00) return 'a multicast address';
  if (h0 === 0x2002) return 'a 6to4 address';
  if (h0 === 0x0064 && h1 === 0xff9b) return 'a NAT64 address';
  return null;
}

/** Returns why an address must not be contacted, or null when it is acceptable. */
export function addressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return ipv4Reason(address);
  if (family === 6) return ipv6Reason(address);
  return 'not an IP address';
}

/**
 * The synchronous half of the policy: scheme, embedded credentials and the always-blocked
 * metadata names. Every network entry point runs this before anything else.
 */
export function assertUrlLiteralAllowed(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password)
    throw new Error('URLs containing embedded credentials are not allowed');
  if (ALWAYS_BLOCKED.has(normalizedHostname(url)))
    throw new Error('Link-local metadata endpoints are not allowed');
}

/**
 * Rejects a model-supplied http/https URL whose host is a metadata service, or that resolves to
 * an address the runtime refuses to contact.
 */
export async function assertPublicUrl(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertUrlLiteralAllowed(url);
  const hostname = normalizedHostname(url);
  if (!hostname) throw new Error('Invalid URL host');
  if (privateNetworkAllowed(env)) return;
  if (isIP(hostname)) {
    const reason = addressReason(hostname);
    if (reason) throw new Error(`Refusing to connect to ${hostname}: it is ${reason}`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(
      `Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!addresses.length) throw new Error(`Could not resolve ${hostname}`);
  for (const entry of addresses) {
    const reason = addressReason(entry.address);
    if (reason)
      throw new Error(`Refusing to fetch ${hostname}: it resolves to ${reason} (${entry.address})`);
  }
}
