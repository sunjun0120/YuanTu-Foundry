/**
 * The style nonce the desktop document authorises, and the single place its value is written.
 *
 * `apps/desktop/index.html` declares `style-src 'self' data: 'nonce-…'` in its CSP meta and repeats the value in
 * `<meta name="yuantu-style-nonce">`; the provider hands the same value to Mantine's `getStyleNonce`, which is how
 * every runtime `<style>` Mantine injects is authorised — CSS variables, global breakpoint classes, and the
 * responsive rules `Box` emits for style props. Without it the CSP blocks those elements and the interface renders
 * unstyled, which is why the test in `tests/desktop-react-csp.test.ts` asserts all three copies agree.
 *
 * **Why one fixed value instead of a fresh nonce per load.** A nonce is unguessable to *markup* that cannot run
 * script; a page script can read this meta. Per-load rotation therefore defends the same notional attacker, at the
 * cost of rewriting the document on every load through a `file:` protocol interceptor. This document is a trusted
 * file installed with the application, and nothing renders untrusted HTML into it — Markdown keeps its existing
 * sanitised path. The threat the nonce does close is CSS the document itself may pick up from a file beside it:
 * an unstyled injection cannot read the meta, and `'self'` alone would let it load a stylesheet. If a path that
 * lets untrusted HTML into the document ever appears, switch to per-load rotation (the plan's §8 optional path)
 * instead of widening this CSP.
 */
export const UI_STYLE_NONCE = 'b7Qm2xL9pR4sT1vW';
export const STYLE_NONCE_META = 'yuantu-style-nonce';

/**
 * The nonce the document was built with, read from the trusted meta.
 *
 * Throws when the meta is missing or does not match this build: a page that disagrees with its provider has either
 * lost the meta in a copy step or shipped two versions, and both render a page whose styles will be refused.
 */
export function styleNonceFromDocument(doc: Document): string {
  const element = doc.querySelector<HTMLMetaElement>(`meta[name="${STYLE_NONCE_META}"]`);
  const value = element?.content;
  if (!value) throw new Error('the document has no style nonce meta');
  if (value !== UI_STYLE_NONCE)
    throw new Error('the document style nonce does not match the application build');
  return value;
}
