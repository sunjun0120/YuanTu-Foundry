/**
 * The three tool-result cards the protocol names, and the dispatch that picks one.
 *
 * A tool result used to be text and nothing else, so a client could only print it. The protocol now carries a
 * *value* beside that text (`ToolResultOutput`), and this module turns the three values this build knows into
 * something worth reading: a file read with its line range, a search as a list of hits, a command with its exit
 * code and separated streams.
 *
 * Three decisions shape everything below.
 *
 * 1. **The card is a view of the value, never a re-parse of the text form.** Splitting `path:line: text` back out
 *    of the string a tool already formatted would break the first time a path contained a colon — which is
 *    exactly why the payload exists — and it would make the card's correctness depend on the tool's formatting
 *    staying put. The text form is still what the model reads and what any other client prints.
 * 2. **Nothing is hidden.** The raw text stays in the same `<details>`, one nested fold away. A card that
 *    replaced the text would be a second source of truth for what the model saw, and the first time the card was
 *    wrong the person reading it would have no way to tell.
 * 3. **The value is validated, not cast.** It arrives from a session log that another build may have written, so
 *    a missing field is a version skew rather than a bug in this file. `toolCardModel` answers `null` for
 *    anything that is not exactly the declared shape, and the caller renders the text it has always rendered:
 *    the card is additive, and skew degrades to yesterday's output instead of an empty box.
 */
import type { ToolCardModel } from './tool-card-model.ts';
import { format, t } from './i18n.ts';

export { toolCardModel } from './tool-card-model.ts';
export type { ToolCardModel } from './tool-card-model.ts';

/** Rows a search card draws before it stops and says so. See the comment inside. */
const MATCH_ROWS = 100;
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}
/** Milliseconds as something short enough for a card's header. */
function duration(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
function head(...children: (HTMLElement | string)[]): HTMLElement {
  const row = node('div', '', 'tool-card-head');
  for (const child of children) row.append(typeof child === 'string' ? node('span', child) : child);
  return row;
}
function badge(text: string, kind: string): HTMLElement {
  return node('span', text, `tool-card-badge tool-card-${kind}`);
}
function stream(text: string, className: string): HTMLElement {
  return node('pre', text, `tool-card-stream ${className}`);
}
/**
 * The card for one view model.
 *
 * It takes a `ToolCardModel` rather than an output, so the validating decision (which payloads can be drawn at
 * all) stays in the pure module where a test without a DOM can reach it — this function only transcribes what it
 * is given. The three branches are the protocol's three renderer names, in the same order.
 */
export function toolCardView(model: ToolCardModel): HTMLElement {
  if (model.kind === 'file-read') {
    const card = node('div', '', 'tool-card tool-card-file');
    const range =
      model.totalLines === 0
        ? t('ui.toolCardEmptyFile')
        : format(t('ui.toolCardLines'), {
            start: model.startLine,
            end: model.endLine,
            total: model.totalLines,
          });
    card.append(
      head(
        node('code', model.path, 'tool-card-path'),
        ...(model.language ? [node('span', model.language, 'tool-card-meta')] : []),
        node('span', range, 'tool-card-meta'),
        ...(model.truncated ? [badge(t('ui.toolCardTruncated'), 'warn')] : []),
      ),
      stream(model.text, 'tool-card-text'),
    );
    return card;
  }
  if (model.kind === 'search-results') {
    const card = node('div', '', 'tool-card tool-card-search');
    card.append(
      head(
        node('code', model.query, 'tool-card-query'),
        node(
          'span',
          model.mode === 'regex' ? t('ui.toolCardRegex') : t('ui.toolCardLiteral'),
          'tool-card-meta',
        ),
        node(
          'span',
          format(t('ui.toolCardMatches'), { count: model.matches.length }),
          'tool-card-meta',
        ),
      ),
    );
    const list = node('ul', '', 'tool-card-matches');
    // A search can return a payload with hundreds of hits, and every row is a real DOM node in a conversation
    // that repaints as the model works. The folded raw text below holds all of them, so the card draws the first
    // hundred and says how many it left out rather than making a repaint cost a thousand nodes.
    for (const match of model.matches.slice(0, MATCH_ROWS)) {
      const item = node('li');
      item.append(
        node('span', `${match.path}:${String(match.line)}`, 'tool-card-match-path'),
        node('span', match.text.trim(), 'tool-card-match-text'),
      );
      list.append(item);
    }
    card.append(list);
    if (model.matches.length > MATCH_ROWS)
      card.append(
        node(
          'p',
          format(t('ui.toolCardMatchRows'), {
            shown: MATCH_ROWS,
            count: model.matches.length,
          }),
          'tool-card-note',
        ),
      );
    if (model.limited) card.append(node('p', t('ui.toolCardLimited'), 'tool-card-note'));
    if (!model.matches.length) card.append(node('p', t('ui.toolCardNoMatches'), 'tool-card-note'));
    return card;
  }
  const card = node('div', '', 'tool-card tool-card-command');
  const exit =
    model.exitCode === null
      ? model.signal
        ? format(t('ui.toolCardSignal'), { signal: model.signal })
        : t('ui.toolCardUnknownExit')
      : format(t('ui.toolCardExit'), { code: model.exitCode });
  card.append(
    head(
      node('code', model.command, 'tool-card-command-line'),
      badge(exit, model.exitCode === 0 ? 'ok' : 'fail'),
      ...(model.timedOut ? [badge(t('ui.toolCardTimeout'), 'warn')] : []),
      node('span', duration(model.durationMs), 'tool-card-meta'),
      ...(model.truncated ? [badge(t('ui.toolCardTruncated'), 'warn')] : []),
    ),
  );
  if (model.stdout) card.append(stream(model.stdout, 'tool-card-stdout'));
  if (model.stderr)
    card.append(
      node('div', t('ui.toolCardStderr'), 'tool-card-label'),
      stream(model.stderr, 'tool-card-stderr'),
    );
  if (!model.stdout && !model.stderr)
    card.append(node('p', t('ui.toolCardNoOutput'), 'tool-card-note'));
  return card;
}
