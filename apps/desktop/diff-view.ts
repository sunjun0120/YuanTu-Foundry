import type { FileChange } from '../../packages/protocol/index.ts';
import { readablePatchPaths } from '../../packages/protocol/patch-display.ts';
import { t } from './i18n.ts';
const labels: Record<FileChange['kind'], string> = {
  create: 'diff.create',
  edit: 'diff.edit',
  delete: 'diff.delete',
  move: 'diff.move',
  batch: 'diff.batch',
};
export type DiffLineClass = 'diff-hunk' | 'diff-added' | 'diff-removed' | 'diff-context';
/**
 * What a unified-diff line is.
 *
 * Every content line carries a one-character marker, so an added line whose own text begins with `++` reads as
 * `+++i;` — not the `+++ b/file` header — and matching the `+++` prefix alone drew it as unchanged context,
 * inside the approval card where a person decides whether to allow the change. A header is the marker followed
 * by the separator (`+++ b/f.txt`), and a file header can only appear before the first `@@`; inside a hunk,
 * every `+`/`-` line is content, which is what tells a deleted `-- keep this comment` (drawn `--- keep this
 * comment`) from the `--- a/f.txt` preamble that reads exactly the same by prefix.
 */
export function classifyDiffLine(line: string, inHunk = false): DiffLineClass {
  if (line.startsWith('@@')) return 'diff-hunk';
  if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) return 'diff-context';
  if (line.startsWith('+')) return 'diff-added';
  if (line.startsWith('-')) return 'diff-removed';
  return 'diff-context';
}
/** The line a diff fold shows while it is closed: what kind of change it is, the path, and the two counts. */
export function diffSummaryText(change: FileChange): string {
  return `${t(labels[change.kind])} ${change.path}  +${change.added} −${change.removed}`;
}
/**
 * What `diffView` puts under its own summary: a batch's child diffs, or the truncation notice and the patch lines.
 *
 * It is separate because the turn-change preview draws the summary and the undo controls itself — React owns that
 * card and its interaction — while the patch body stays the shared builder's account of a diff. Splitting it here
 * keeps both readers on the same classification, the same readable paths and the same order.
 */
export function diffBody(change: FileChange, expanded = false): Node[] {
  if (change.changes?.length) {
    const group = document.createElement('div');
    group.className = 'file-diff-group';
    for (const child of change.changes) group.append(diffView(child, expanded));
    return [group];
  }
  const nodes: Node[] = [];
  if (change.truncated) {
    const notice = document.createElement('p');
    notice.className = 'diff-notice';
    notice.textContent = t('diff.incomplete');
    nodes.push(notice);
  }
  const pre = document.createElement('pre');
  // The file header only precedes the first hunk; after that, a `-`/`+` line is content whatever it spells.
  // Header names are decoded for display: the patch keeps its ASCII-safe quoting, this is what a person reads.
  let inHunk = false;
  for (const line of readablePatchPaths(change.patch).split('\n')) {
    const row = document.createElement('span');
    const lineClass = classifyDiffLine(line, inHunk);
    if (lineClass === 'diff-hunk') inHunk = true;
    row.className = lineClass;
    row.textContent = line + '\n';
    pre.append(row);
  }
  nodes.push(pre);
  return nodes;
}
export function diffView(change: FileChange, expanded = false): HTMLElement {
  const root = document.createElement('details');
  root.className = 'file-diff';
  root.open = expanded;
  const title = document.createElement('summary');
  title.textContent = diffSummaryText(change);
  root.append(title, ...diffBody(change, expanded));
  return root;
}
