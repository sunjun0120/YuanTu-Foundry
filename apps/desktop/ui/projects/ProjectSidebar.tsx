/**
 * The left sidebar's project list: the registry's workspaces, their display names and the actions that only rename
 * or unregister them. Selecting a project asks the main process to switch its Host; adding opens the native picker.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type {
  ProjectRuntimeView,
  ProjectWorkspacesFile,
  ProjectWorkspaceReply,
} from '../../project-workspaces-contract.ts';
import { t } from '../../i18n.ts';

export function ProjectSidebar({ canChange }: { canChange: boolean }): ReactNode {
  const [registry, setRegistry] = useState<ProjectWorkspacesFile | null>(null);
  const [runtime, setRuntime] = useState<Record<string, ProjectRuntimeView>>({});
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    void bridge({ type: 'list' })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) {
          setRegistry(reply.registry);
          if (reply.runtime) setRuntime(reply.runtime);
        } else setError(reply.error);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, []);

  const reload = async (): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    const reply = await bridge({ type: 'list' });
    if (reply.ok) {
      setRegistry(reply.registry);
      if (reply.runtime) setRuntime(reply.runtime);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, []);

  const apply = (reply: ProjectWorkspaceReply): boolean => {
    if (!reply.ok) {
      setError(reply.error);
      return false;
    }
    setError('');
    setRegistry(reply.registry);
    if (reply.runtime) setRuntime(reply.runtime);
    return true;
  };

  const select = async (id: string): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    apply(await bridge({ type: 'select', id }));
  };
  const openSession = async (workspaceId: string, sessionId: string): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge || !canChange) return;
    const reply = await bridge({ type: 'select', id: workspaceId });
    if (!apply(reply)) return;
    const invoke = window.yuantu?.invoke;
    if (invoke) await invoke({ type: 'load', id: sessionId });
  };
  const toggleCollapse = async (id: string, collapsed: boolean): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    apply(await bridge({ type: 'collapse', id, collapsed }));
  };
  const remove = async (id: string): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    const wasActive = registry?.activeWorkspaceId === id;
    const reply = await bridge({ type: 'remove', id });
    if (!apply(reply) || !reply.ok) return;
    setRemoving(null);
    const next = reply.registry.activeWorkspaceId;
    if (wasActive && next) await select(next);
  };
  const saveName = async (id: string): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    const reply = await bridge({ type: 'rename', id, displayName: name });
    if (apply(reply)) setEditing(null);
  };

  const choose = (): void => {
    // The legacy session controller owns the error banner and the Host switch; this visible control forwards to it.
    document.getElementById('choose-workspace')?.click();
    // The picker and the Host switch are asynchronous; reading the registry again after them keeps the list current.
    window.setTimeout(() => void reload(), 400);
    window.setTimeout(() => void reload(), 1500);
  };

  const visible = registry?.workspaces.filter((workspace) => !workspace.removed) ?? [];
  const waiting = visible.flatMap((workspace) =>
    (runtime[workspace.id]?.sessions ?? [])
      .filter((session) => session.waiting > 0)
      .map((session) => ({ workspace, session })),
  );
  const activePath =
    visible.find((workspace) => workspace.id === registry?.activeWorkspaceId)?.canonicalPath ?? '';
  return (
    <section className="project-sidebar" aria-label={t('projects.title')}>
      <div id="workspace" hidden translate="no">
        {activePath}
      </div>
      <div className="section-label">{t('projects.title')}</div>
      {waiting.length ? (
        <button
          type="button"
          className="project-waiting-summary"
          disabled={!canChange}
          onClick={() => {
            const first = waiting[0];
            if (first) void openSession(first.workspace.id, first.session.id);
          }}
        >
          {t('projects.waitingSummary', { count: waiting.length })}
          <span aria-hidden="true">!</span>
        </button>
      ) : null}
      {visible.length ? (
        <ul className="project-list">
          {visible.map((workspace) => {
            const active = registry?.activeWorkspaceId === workspace.id;
            const status = runtime[workspace.id];
            const waitingSession = status?.sessions.find((session) => session.waiting > 0);
            return (
              <li
                key={workspace.id}
                className={`project-row${active ? ' selected' : ''}`}
                data-project-id={workspace.id}
              >
                <button
                  type="button"
                  className="project-disclosure"
                  aria-expanded={!workspace.collapsed}
                  aria-label={workspace.collapsed ? t('projects.expand') : t('projects.collapse')}
                  title={workspace.collapsed ? t('projects.expand') : t('projects.collapse')}
                  onClick={() => void toggleCollapse(workspace.id, !workspace.collapsed)}
                >
                  {workspace.collapsed ? '▸' : '▾'}
                </button>
                <button
                  type="button"
                  className="project-name"
                  title={workspace.canonicalPath}
                  aria-current={active ? 'true' : undefined}
                  disabled={!canChange}
                  onClick={() =>
                    waitingSession
                      ? void openSession(workspace.id, waitingSession.id)
                      : void select(workspace.id)
                  }
                >
                  <span>{workspace.displayName}</span>
                  {status?.waiting ? (
                    <span
                      className="project-badge waiting"
                      title={t('projects.waiting', { count: status.waiting })}
                      aria-label={t('projects.waiting', { count: status.waiting })}
                    >
                      !
                    </span>
                  ) : status?.running ? (
                    <span
                      className="project-badge running"
                      title={t('projects.running')}
                      aria-label={t('projects.running')}
                    >
                      ●
                    </span>
                  ) : null}
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
                {!workspace.collapsed && status?.sessions.length ? (
                  <ul className="project-sessions">
                    {status.sessions.slice(0, 5).map((session) => (
                      <li key={session.id}>
                        <button
                          type="button"
                          disabled={!canChange}
                          title={session.title || t('ui.untitledSession')}
                          onClick={() => void openSession(workspace.id, session.id)}
                        >
                          <span>{session.title || t('ui.untitledSession')}</span>
                          {session.waiting ? (
                            <span
                              className="project-badge waiting"
                              title={t('projects.waiting', { count: session.waiting })}
                              aria-label={t('projects.waiting', { count: session.waiting })}
                            >
                              !
                            </span>
                          ) : session.running ? (
                            <span className="project-badge running" aria-hidden="true">
                              ●
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
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
        id="project-choose"
        type="button"
        className="text-button project-add"
        disabled={!canChange}
        onClick={choose}
      >
        {t('ui.changeFolder')}
        <span aria-hidden="true">↗</span>
      </button>
      <button id="choose-workspace" type="button" hidden disabled={!canChange}>
        {t('ui.changeFolder')}
      </button>
    </section>
  );
}
