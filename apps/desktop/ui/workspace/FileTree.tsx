/**
 * The file tree: one row per entry, directories expandable, files selectable.
 *
 * The tree is a projection of `workspace-model.ts` — listings, failures, expansion, selection. A directory that is
 * expanded but not yet read shows "reading" (or the failure), because "not read yet" and "empty" are different
 * answers about a workspace.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import type { WorkspaceEntry } from '../../../../packages/protocol/rpc.ts';
import type { WorkspaceController, WorkspaceState } from './workspace-model.ts';
import { Icon, type IconKind } from './Icon.tsx';

function EntryRow({
  entry,
  state,
  controller,
  onBeforeSelect,
}: {
  entry: WorkspaceEntry;
  state: WorkspaceState;
  controller: WorkspaceController;
  onBeforeSelect(): void;
}): ReactNode {
  const expanded = state.expanded.has(entry.path);
  const selected = state.selected === entry.path;
  const icon: IconKind =
    entry.kind === 'directory'
      ? expanded
        ? 'folder-open'
        : 'folder'
      : /\.(?:md|markdown|mdown)$/i.test(entry.path)
        ? 'markdown'
        : 'file';
  return (
    <li className="workspace-entry">
      <button
        type="button"
        className="workspace-entry-button"
        data-path={entry.path}
        title={entry.path}
        translate="no"
        aria-expanded={entry.kind === 'directory' ? expanded : undefined}
        aria-current={entry.kind === 'file' ? (selected ? 'true' : 'false') : undefined}
        onClick={() => {
          if (entry.kind === 'directory') {
            controller.toggleDirectory(entry.path);
            return;
          }
          // Leaving the preview for another file keeps the reading position of the file being left.
          onBeforeSelect();
          void controller.showFile(entry.path);
        }}
      >
        <span className="workspace-entry-glyph" aria-hidden="true">
          <Icon kind={icon} />
        </span>
        <span className="workspace-entry-name">{entry.name}</span>
      </button>
      {entry.kind === 'directory' && expanded ? (
        <TreeList
          path={entry.path}
          state={state}
          controller={controller}
          onBeforeSelect={onBeforeSelect}
        />
      ) : null}
    </li>
  );
}

export function TreeList({
  path,
  state,
  controller,
  onBeforeSelect,
}: {
  path: string;
  state: WorkspaceState;
  controller: WorkspaceController;
  onBeforeSelect(): void;
}): ReactNode {
  const listing = state.listings.get(path);
  const failure = state.failures.get(path);
  if (!listing) {
    return (
      <ul className="workspace-list">
        <li className="workspace-note">{failure ?? t('workspace.loading')}</li>
      </ul>
    );
  }
  if (!listing.entries.length) {
    return (
      <ul className="workspace-list">
        <li className="workspace-note">{t('workspace.emptyDirectory')}</li>
      </ul>
    );
  }
  return (
    <ul className="workspace-list">
      {listing.entries.map((entry) => (
        <EntryRow
          key={entry.path}
          entry={entry}
          state={state}
          controller={controller}
          onBeforeSelect={onBeforeSelect}
        />
      ))}
      {listing.truncated ? (
        <li className="workspace-note">
          {t('workspace.truncated', { count: listing.entries.length })}
        </li>
      ) : null}
    </ul>
  );
}

export function FileTree({
  state,
  controller,
  hidden,
  onBeforeSelect,
}: {
  state: WorkspaceState;
  controller: WorkspaceController;
  hidden: boolean;
  onBeforeSelect(): void;
}): ReactNode {
  return (
    <div
      id="workspace-tree"
      className="workspace-tree"
      role="group"
      aria-label={t('workspace.treeLabel')}
      tabIndex={-1}
      hidden={hidden}
    >
      <TreeList path="" state={state} controller={controller} onBeforeSelect={onBeforeSelect} />
    </div>
  );
}
