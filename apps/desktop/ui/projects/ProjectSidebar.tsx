/**
 * The left sidebar's project list: the registry's workspaces, their display names and the actions that only rename
 * or unregister them. Selecting a project asks the main process to switch its Host; adding opens the native picker.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@mantine/core';
import type {
  ProjectRuntimeView,
  ProjectWorkspacesFile,
  ProjectWorkspaceReply,
} from '../../project-workspaces-contract.ts';
import { t } from '../../i18n.ts';
import { WorkspaceInteractions } from './WorkspaceInteractions.tsx';
import { ViewSlot } from '../views.tsx';

export function ProjectSidebar({
  canChange,
  legacyCanChange,
}: {
  canChange: boolean;
  legacyCanChange: boolean;
}): ReactNode {
  const [registry, setRegistry] = useState<ProjectWorkspacesFile | null>(null);
  const [runtime, setRuntime] = useState<Record<string, ProjectRuntimeView>>({});
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const selection = useRef(0);

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
    const unsubscribe = window.yuantu?.subscribeWorkspaces?.((event) => {
      if (event.type === 'state' && event.active) void reload();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
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
    const version = ++selection.current;
    const reply = await bridge({ type: 'select', id });
    if (version === selection.current) apply(reply);
  };
  const openSession = async (workspaceId: string, sessionId: string): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge || !canChange) return;
    const reply = await bridge({ type: 'select', id: workspaceId });
    if (!reply.ok || !apply(reply) || !reply.target) return;
    const loaded = await window.yuantu.workspaceInvoke?.(reply.target, {
      type: 'load',
      id: sessionId,
    });
    if (loaded && !loaded.ok) setError(loaded.error);
  };
  const toggleCollapse = async (id: string, collapsed: boolean): Promise<void> => {
    const bridge = window.yuantu?.projects;
    if (!bridge) return;
    apply(await bridge({ type: 'collapse', id, collapsed }));
    if (!collapsed) apply(await bridge({ type: 'prepare', id }));
  };
  const createSession = async (id: string): Promise<void> => {
    const reply = await window.yuantu.projects({ type: 'select', id });
    if (!reply.ok || !apply(reply) || !reply.target) return;
    const created = await window.yuantu.workspaceInvoke?.(reply.target, { type: 'create' });
    if (created && !created.ok) setError(created.error);
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
    void window.yuantu
      .projects({ type: 'add' })
      .then(async (reply) => {
        if (apply(reply) && reply.ok && reply.addedId) await select(reply.addedId);
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  };

  const visible = registry?.workspaces.filter((workspace) => !workspace.removed) ?? [];
  const activePath =
    visible.find((workspace) => workspace.id === registry?.activeWorkspaceId)?.canonicalPath ?? '';
  return (
    <section className="project-sidebar" aria-label={t('projects.title')}>
      <div id="workspace" hidden translate="no">
        {activePath}
      </div>
      <div className="project-group-header">
        <button
          type="button"
          className="project-group-toggle"
          aria-expanded={!registry?.projectsCollapsed}
          onClick={() => {
            void window.yuantu
              .projects({ type: 'groupCollapse', collapsed: !registry?.projectsCollapsed })
              .then(apply);
          }}
        >
          <span aria-hidden="true">{registry?.projectsCollapsed ? '▸' : '▾'}</span>{' '}
          {t('projects.title')}
        </button>
        <button
          type="button"
          className="project-add-button"
          disabled={!canChange}
          aria-label={t('projects.add')}
          title={t('projects.add')}
          onClick={choose}
        >
          ＋
        </button>
      </div>
      <WorkspaceInteractions registry={registry} />
      <div className="project-scroll" hidden={registry?.projectsCollapsed}>
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
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <button
                            type="button"
                            aria-label={t('projects.actions')}
                            title={t('projects.actions')}
                          >
                            ···
                          </button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            onClick={() => {
                              setEditing(workspace.id);
                              setName(workspace.displayName);
                            }}
                          >
                            {t('projects.rename')}
                          </Menu.Item>
                          <Menu.Item onClick={() => setRemoving(workspace.id)}>
                            {t('projects.remove')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                      <button
                        type="button"
                        disabled={!canChange}
                        aria-label={t('projects.newSession', { name: workspace.displayName })}
                        title={t('projects.newSession', { name: workspace.displayName })}
                        onClick={() => {
                          void createSession(workspace.id);
                        }}
                      >
                        ＋
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
                  {active ? (
                    <div
                      id="session-sidebar-root"
                      className="session-sidebar-root project-session-content"
                      hidden={workspace.collapsed}
                    >
                      <ViewSlot name="session-sidebar" />
                    </div>
                  ) : null}
                  {!active && !workspace.collapsed && status?.sessions.length ? (
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
      </div>
      {!visible.some((entry) => entry.id === registry?.activeWorkspaceId) ? (
        <div id="session-sidebar-root" className="session-sidebar-root">
          <ViewSlot name="session-sidebar" />
        </div>
      ) : null}
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
      <button id="choose-workspace" type="button" hidden disabled={!legacyCanChange}>
        {t('ui.changeFolder')}
      </button>
    </section>
  );
}
