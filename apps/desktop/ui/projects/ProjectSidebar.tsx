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
import { COLLAPSED_ROWS, sessionAge } from '../sessions/session-model.ts';
import { t, locale } from '../../i18n.ts';
import { WorkspaceInteractions } from './WorkspaceInteractions.tsx';
import { ViewSlot } from '../views.tsx';
import { Icon } from '../workspace/Icon.tsx';
import { ProjectSearch } from './ProjectSearch.tsx';

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
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const selection = useRef(0);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const removeCancel = useRef<HTMLButtonElement>(null);

  // Removing asks in the same modal the session delete uses; focus starts on Cancel so Enter alone never removes.
  useEffect(() => {
    const element = removeDialog.current;
    if (!element) return;
    if (removing) {
      if (!element.open) {
        element.showModal();
        removeCancel.current?.focus();
      }
    } else if (element.open) element.close();
  }, [removing]);

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
  const openSession = async (workspaceId: string, sessionId: string): Promise<boolean> => {
    const bridge = window.yuantu?.projects;
    if (!bridge || !canChange) return false;
    const reply = await bridge({ type: 'select', id: workspaceId });
    if (!reply.ok) {
      apply(reply);
      return false;
    }
    if (!apply(reply) || !reply.target) return false;
    if (reply.registry.workspaces.find((entry) => entry.id === workspaceId)?.collapsed)
      apply(await bridge({ type: 'collapse', id: workspaceId, collapsed: false }));
    const loaded = await window.yuantu.workspaceInvoke?.(reply.target, {
      type: 'load',
      id: sessionId,
    });
    if (loaded && !loaded.ok) setError(loaded.error);
    return Boolean(loaded?.ok);
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
      <ProjectSearch
        registry={registry}
        canChange={canChange}
        openSession={openSession}
        heading={
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
            {t('projects.title')}{' '}
            <Icon kind={registry?.projectsCollapsed ? 'chevron-right' : 'chevron-down'} />
          </button>
        }
        addAction={
          <button
            type="button"
            className="project-add-button"
            disabled={!canChange}
            aria-label={t('projects.add')}
            title={t('projects.add')}
            onClick={choose}
          >
            <Icon kind="folder-plus" />
          </button>
        }
      >
        <WorkspaceInteractions registry={registry} />
        <div className="project-scroll" hidden={registry?.projectsCollapsed}>
          {visible.length ? (
            <ul className="project-list">
              {visible.map((workspace) => {
                const active = registry?.activeWorkspaceId === workspace.id;
                const status = runtime[workspace.id];
                return (
                  <li
                    key={workspace.id}
                    className={`project-row${active ? ' selected' : ''}`}
                    data-project-id={workspace.id}
                  >
                    <div className="project-row-header">
                      <button
                        type="button"
                        className="project-disclosure"
                        aria-expanded={!workspace.collapsed}
                        aria-label={
                          workspace.collapsed ? t('projects.expand') : t('projects.collapse')
                        }
                        title={workspace.collapsed ? t('projects.expand') : t('projects.collapse')}
                        onClick={() => void toggleCollapse(workspace.id, !workspace.collapsed)}
                      >
                        <Icon kind={workspace.collapsed ? 'folder-closed' : 'folder-open'} />
                      </button>
                      <button
                        type="button"
                        className="project-name"
                        title={workspace.canonicalPath}
                        aria-current={active ? 'true' : undefined}
                        aria-expanded={!workspace.collapsed}
                        disabled={!canChange}
                        onClick={() => void toggleCollapse(workspace.id, !workspace.collapsed)}
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
                                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
                                  <circle cx="8" cy="8" r="1.25" fill="currentColor" />
                                  <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
                                </svg>
                              </button>
                            </Menu.Target>
                            <Menu.Dropdown className="project-menu">
                              <Menu.Item
                                onClick={() => {
                                  setEditing(workspace.id);
                                  setName(workspace.displayName);
                                }}
                              >
                                {t('projects.rename')}
                              </Menu.Item>
                              <Menu.Item
                                className="danger-text"
                                onClick={() => setRemoving(workspace.id)}
                              >
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
                            <Icon kind="plus-circle" />
                          </button>
                        </div>
                      )}
                    </div>
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
                        {status.sessions
                          .slice(0, expandedProjects.has(workspace.id) ? undefined : COLLAPSED_ROWS)
                          .map((session) => (
                            <li key={session.id}>
                              <button
                                type="button"
                                disabled={!canChange}
                                title={session.title || t('ui.untitledSession')}
                                onClick={() => void openSession(workspace.id, session.id)}
                              >
                                <span>{session.title || t('ui.untitledSession')}</span>
                                {session.createdAt ? (
                                  <small>{sessionAge(session.createdAt, locale())}</small>
                                ) : null}
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
                        {status.sessions.length > COLLAPSED_ROWS ? (
                          <li>
                            <button
                              type="button"
                              className="session-load-more session-toggle"
                              aria-expanded={expandedProjects.has(workspace.id)}
                              onClick={() =>
                                setExpandedProjects((previous) => {
                                  const next = new Set(previous);
                                  if (next.has(workspace.id)) next.delete(workspace.id);
                                  else next.add(workspace.id);
                                  return next;
                                })
                              }
                            >
                              {t(
                                expandedProjects.has(workspace.id)
                                  ? 'ui.showFewerSessions'
                                  : 'projects.showMoreSessions',
                              )}
                            </button>
                          </li>
                        ) : null}
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
      </ProjectSearch>
      {!visible.some((entry) => entry.id === registry?.activeWorkspaceId) ? (
        <div id="session-sidebar-root" className="session-sidebar-root">
          <ViewSlot name="session-sidebar" />
        </div>
      ) : null}
      <dialog
        ref={removeDialog}
        id="project-remove-dialog"
        className="session-dialog"
        aria-labelledby="project-remove-title"
        onCancel={(event) => {
          event.preventDefault();
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (removing) void remove(removing);
          }}
        >
          <h2 id="project-remove-title">{t('projects.removeTitle')}</h2>
          <p>
            {t('projects.removeDescription', {
              name: visible.find((entry) => entry.id === removing)?.displayName ?? '',
            })}
          </p>
          <div className="session-dialog-actions">
            <button ref={removeCancel} type="button" onClick={() => setRemoving(null)}>
              {t('session.cancel')}
            </button>
            <button id="project-remove-confirm" type="submit" className="primary">
              {t('projects.remove')}
            </button>
          </div>
        </form>
      </dialog>
      {error ? (
        <p className="project-error" role="alert">
          {error}
        </p>
      ) : null}
      <button id="choose-workspace" type="button" hidden disabled={!legacyCanChange}>
        {t('ui.changeFolder')}
      </button>
    </section>
  );
}
