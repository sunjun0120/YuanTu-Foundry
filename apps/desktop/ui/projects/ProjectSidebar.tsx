/**
 * The left sidebar's project list: the registry's workspaces, their display names and the actions that only rename
 * or unregister them. Selecting a project asks the main process to switch its Host; adding opens the native picker.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type {
  ProjectWorkspacesFile,
  ProjectWorkspaceReply,
} from '../../project-workspaces-contract.ts';
import { t } from '../../i18n.ts';

export function ProjectSidebar({ canChange }: { canChange: boolean }): ReactNode {
  const [registry, setRegistry] = useState<ProjectWorkspacesFile | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.yuantu
      .projects?.({ type: 'list' })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) setRegistry(reply.registry);
        else setError(reply.error);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, []);

  const apply = (reply: ProjectWorkspaceReply): boolean => {
    if (!reply.ok) {
      setError(reply.error);
      return false;
    }
    setError('');
    setRegistry(reply.registry);
    return true;
  };

  const add = async (): Promise<void> => {
    const reply = await window.yuantu.projects({ type: 'add' });
    apply(reply);
  };
  const select = async (id: string): Promise<void> => {
    const reply = await window.yuantu.projects({ type: 'select', id });
    apply(reply);
  };
  const remove = async (id: string): Promise<void> => {
    const wasActive = registry?.activeWorkspaceId === id;
    const reply = await window.yuantu.projects({ type: 'remove', id });
    if (!apply(reply) || !reply.ok) return;
    setRemoving(null);
    const next = reply.registry.activeWorkspaceId;
    if (wasActive && next) await select(next);
  };
  const saveName = async (id: string): Promise<void> => {
    const reply = await window.yuantu.projects({ type: 'rename', id, displayName: name });
    if (apply(reply)) setEditing(null);
  };

  const visible = registry?.workspaces.filter((workspace) => !workspace.removed) ?? [];
  return (
    <section className="project-sidebar" aria-label={t('projects.title')}>
      <div className="section-label">{t('projects.title')}</div>
      {visible.length ? (
        <ul className="project-list">
          {visible.map((workspace) => {
            const active = registry?.activeWorkspaceId === workspace.id;
            return (
              <li
                key={workspace.id}
                className={`project-row${active ? ' selected' : ''}`}
                data-project-id={workspace.id}
              >
                <button
                  type="button"
                  className="project-name"
                  title={workspace.canonicalPath}
                  aria-current={active ? 'true' : undefined}
                  disabled={!canChange}
                  onClick={() => void select(workspace.id)}
                >
                  <span>{workspace.displayName}</span>
                </button>
                {editing === workspace.id ? (
                  <form
                    className="project-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveName(workspace.id);
                    }}
                  >
                    <input
                      aria-label={t('projects.rename')}
                      value={name}
                      autoFocus
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                    <button type="submit" disabled={!name.trim()}>
                      ✓
                    </button>
                  </form>
                ) : (
                  <div className="project-actions">
                    <button
                      type="button"
                      aria-label={t('projects.rename')}
                      title={t('projects.rename')}
                      onClick={() => {
                        setEditing(workspace.id);
                        setName(workspace.displayName);
                      }}
                    >
                      …
                    </button>
                    <button
                      type="button"
                      aria-label={t('projects.remove')}
                      title={t('projects.remove')}
                      onClick={() => setRemoving(removing === workspace.id ? null : workspace.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
                {removing === workspace.id ? (
                  <div className="project-remove">
                    <span>{t('projects.removeConfirm')}</span>
                    <button type="button" onClick={() => void remove(workspace.id)}>
                      {t('projects.remove')}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="project-empty">{t('projects.empty')}</p>
      )}
      {error ? (
        <p className="project-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        id="choose-workspace"
        type="button"
        className="text-button project-add"
        disabled={!canChange}
        onClick={() => void add()}
      >
        {t('projects.add')}
        <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
