import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  ProjectRuntimeView,
  ProjectWorkspacesFile,
} from '../../project-workspaces-contract.ts';
import { locale, t } from '../../i18n.ts';
import { sessionAge } from '../sessions/session-model.ts';
import { AssetIcon } from '../icons/AssetIcon.tsx';
import { Icon } from '../workspace/Icon.tsx';
import { useSection } from '../context.tsx';

/** The collapsed rail reads the same registry and invokes the same actions as the expanded space list. */
export function CollapsedSpaces({
  collapsed,
  registry,
  runtime,
  canChange,
  choose,
  toggleCollapse,
  openSession,
}: {
  collapsed: boolean;
  registry: ProjectWorkspacesFile | null;
  runtime: Record<string, ProjectRuntimeView>;
  canChange: boolean;
  choose(): void;
  toggleCollapse(id: string, collapsed: boolean): Promise<void>;
  openSession(spaceId: string, sessionId: string): Promise<boolean>;
}): ReactNode {
  const [opened, setOpened] = useState(false);
  const [top, setTop] = useState(112);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!collapsed) setOpened(false);
  }, [collapsed]);
  useEffect(() => {
    if (!opened || !collapsed) return;
    card.current?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent): void => {
      if (
        !card.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpened(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpened(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [opened, collapsed]);
  return (
    <>
      <button
        ref={trigger}
        id="collapsed-spaces-trigger"
        className="collapsed-spaces-trigger"
        type="button"
        hidden={!collapsed}
        aria-label={t('projects.title')}
        data-sidebar-tooltip={t('projects.title')}
        aria-expanded={opened}
        aria-controls="collapsed-spaces-card"
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          if (rect) setTop(Math.max(8, Math.min(rect.top, innerHeight - 328)));
          setOpened((value) => !value);
        }}
      >
        <AssetIcon name="folder" />
      </button>
      {createPortal(
        <section
          ref={card}
          id="collapsed-spaces-card"
          className="collapsed-spaces-card"
          hidden={!collapsed || !opened}
          style={{ top }}
          aria-label={t('projects.title')}
          tabIndex={-1}
        >
          <header>
            <h2>{t('projects.title')}</h2>
            <button
              type="button"
              aria-label={t('projects.add')}
              data-sidebar-tooltip={t('projects.add')}
              disabled={!canChange}
              onClick={() => {
                setOpened(false);
                choose();
              }}
            >
              <Icon kind="plus" />
            </button>
          </header>
          {collapsed && opened ? (
            <SpaceList
              registry={registry}
              runtime={runtime}
              canChange={canChange}
              toggleCollapse={toggleCollapse}
              openSession={openSession}
              close={() => setOpened(false)}
            />
          ) : null}
        </section>,
        document.body,
      )}
    </>
  );
}

/**
 * The open card's spaces and their sessions. The open space's sessions come from the window's own list, so they
 * match the expanded sidebar; reading it only while the card is open keeps the rail itself free of the runtime.
 */
function SpaceList({
  registry,
  runtime,
  canChange,
  toggleCollapse,
  openSession,
  close,
}: {
  registry: ProjectWorkspacesFile | null;
  runtime: Record<string, ProjectRuntimeView>;
  canChange: boolean;
  toggleCollapse(id: string, collapsed: boolean): Promise<void>;
  openSession(spaceId: string, sessionId: string): Promise<boolean>;
  close(): void;
}): ReactNode {
  const currentWorkspace = useSection('workspace');
  const currentSessions = useSection('sessions');
  const spaces = registry?.workspaces.filter((space) => !space.removed) ?? [];
  return (
    <>
      {spaces.map((space) => {
        const sessions =
          space.canonicalPath === currentWorkspace && currentSessions
            ? currentSessions.filter((session) => !session.parentSessionId)
            : (runtime[space.id]?.sessions ?? []);
        return (
          <div key={space.id} className="collapsed-space">
            <button
              type="button"
              className="collapsed-space-row"
              aria-expanded={!space.collapsed}
              onClick={() => {
                void toggleCollapse(space.id, !space.collapsed);
              }}
            >
              <AssetIcon name="folder" size={16} />
              <span>{space.displayName}</span>
              <Icon kind={space.collapsed ? 'chevron-right' : 'chevron-down'} />
            </button>
            {!space.collapsed
              ? sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="collapsed-space-session"
                    disabled={!canChange}
                    onClick={() => {
                      void openSession(space.id, session.id).then((ok) => {
                        if (ok) close();
                      });
                    }}
                  >
                    <span>{session.title || t('ui.untitledSession')}</span>
                    {session.createdAt ? (
                      <small>{sessionAge(session.createdAt, locale())}</small>
                    ) : null}
                  </button>
                ))
              : null}
          </div>
        );
      })}
      {!spaces.length ? <p>{t('projects.empty')}</p> : null}
    </>
  );
}
