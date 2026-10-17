/**
 * How text written in a script without spaces between words reaches an FTS5 index.
 *
 * Both full-text indexes this product keeps (the session index and the knowledge index) use FTS5's `unicode61`
 * tokenizer, which splits on spaces and punctuation and nothing else. Chinese and Japanese put no space between
 * words, so a whole clause such as `我们修复了数据库迁移的问题` became *one* token, and a search for `数据库` — a
 * word inside it — matched nothing. Korean separates words, but a word carries its particles, so `데이터베이스를`
 * did not match `데이터베이스` either.
 *
 * The fix is one index, not two: every character of those scripts is made its own token by putting a separator
 * on both sides of it, and a query word is segmented the same way and searched as a *phrase*, which FTS5 matches
 * only where the tokens are adjacent and in order. `数据库` therefore finds the clause above, `数据 迁移` finds it
 * with both words, `移迁` does not find `迁移`, and Latin text is tokenized exactly as before. A trigram index was
 * the alternative, and the reason it lost: FTS5's trigram tokenizer cannot `MATCH` anything shorter than three
 * characters, and most Chinese words are two (`迁移`, `会话`), so it would have needed a second, scanning path
 * for exactly the common case.
 *
 * The separator is U+200B ZERO WIDTH SPACE. `unicode61` treats every character outside the letter, number and
 * private-use categories as a separator, and a format character (Cf) is one; it also renders as nothing, so a
 * snippet FTS5 cuts from the indexed text is turned back into the original by deleting it ({@link ftsDisplayText}).
 * Any U+200B already in the input is dropped first, which is what makes segmenting idempotent: an upgrade can
 * re-segment text that is already segmented and get the same string back.
 */
const SEPARATOR = '​';
const SEPARATORS = /​+/g;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** The text an FTS5 `unicode61` index should hold for `text`: every Han, kana and Hangul character its own token. */
export function ftsIndexText(text: string): string {
  return text
    .replace(SEPARATORS, '')
    .replace(UNSPACED, (character) => SEPARATOR + character + SEPARATOR)
    .replace(SEPARATORS, SEPARATOR);
}

/** Text cut from an index written by {@link ftsIndexText} (a `snippet()`), as the person wrote it. */
export function ftsDisplayText(text: string): string {
  return text.replace(SEPARATORS, '');
}

/**
 * Free-form search text as an FTS5 query, or null when there is nothing indexable in it.
 *
 * User input must never reach `MATCH` verbatim: a stray `"`, `*`, `-`, `:` or `NEAR` is FTS5 syntax and makes the
 * statement throw. Words are extracted, each is segmented like the index and quoted as a phrase, and the phrases
 * are AND-joined, so every word must appear. Text with no word characters at all returns null, because an empty
 * FTS5 phrase is itself a syntax error.
 */
export function ftsMatchQuery(text: string, maxWords: number): string | null {
  const words = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0]!).slice(0, maxWords);
  return words.length ? words.map((word) => `"${ftsIndexText(word)}"`).join(' AND ') : null;
}
