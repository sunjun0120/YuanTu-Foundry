/**
 * Characters XML 1.0 does not allow in content: C0 controls other than tab, newline and carriage return, the two
 * non-characters U+FFFE and U+FFFF, and surrogate halves that are not part of a pair.
 */
const FORBIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text made safe to write into an Office XML part.
 *
 * Model output and pasted text carry stray control characters (a vertical tab from a copied form, a NUL from a
 * decoded byte). The generators write text as given, and one such character makes the part ill-formed, so Word
 * and PowerPoint refuse the whole file as corrupt; mammoth and the slide reader still read it, so the check after
 * writing would not notice. They carry no visible text, so dropping them loses nothing a reader would see.
 */
export const xmlText = (value: string): string => value.replace(FORBIDDEN, '');
