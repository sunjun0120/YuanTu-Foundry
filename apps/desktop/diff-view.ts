import type { FileChange } from '../../packages/protocol/index.ts';
import { t } from './i18n.ts';
const labels: Record<FileChange['kind'], string> = {
  create: 'diff.create',
  edit: 'diff.edit',
  delete: 'diff.delete',
  move: 'diff.move',
  batch: 'diff.batch',
};
export function diffView(change: FileChange, expanded = false): HTMLElement {
  const root = document.createElement('details');
  root.className = 'file-diff';
  root.open = expanded;
  const title = document.createElement('summary');
  title.textContent = `${t(labels[change.kind])} ${change.path}  +${change.added} −${change.removed}`;
  root.append(title);
  if (change.changes?.length) {
    const group = document.createElement('div');
    group.className = 'file-diff-group';
    for (const child of change.changes) group.append(diffView(child, expanded));
    root.append(group);
    return root;
  }
  if (change.truncated) {
    const notice = document.createElement('p');
    notice.className = 'diff-notice';
    notice.textContent = t('diff.incomplete');
    root.append(notice);
  }
  const pre = document.createElement('pre');
  for (const line of change.patch.split('\n')) {
    const row = document.createElement('span');
    row.className = line.startsWith('@@')
      ? 'diff-hunk'
      : line.startsWith('+') && !line.startsWith('+++')
        ? 'diff-added'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'diff-removed'
          : 'diff-context';
    row.textContent = line + '\n';
    pre.append(row);
  }
  root.append(pre);
  return root;
}
