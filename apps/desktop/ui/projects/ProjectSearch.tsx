import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, locale } from '../../i18n.ts';
import type {
  ProjectSessionSearch,
  ProjectWorkspacesFile,
} from '../../project-workspaces-contract.ts';
import { Icon } from '../workspace/Icon.tsx';
import { sessionAge } from '../sessions/session-model.ts';

/** Global search replaces the project heading inline; results remain inside the sidebar. */
export function ProjectSearch({
  registry,
  canChange,
  openSession,
  heading,
  addAction,
  children,
}: {
  registry: ProjectWorkspacesFile | null;
  canChange: boolean;
  openSession(workspaceId: string, sessionId: string): Promise<boolean>;
  heading: ReactNode;
  addAction: ReactNode;
  children: ReactNode;
}): ReactNode {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ProjectSessionSearch>({ hits: [], errors: [] });
  const [searchedRegistry, setSearchedRegistry] = useState<ProjectWorkspacesFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const workspaceKey = registry?.workspaces
    .filter((entry) => !entry.removed)
    .map((entry) => entry.id)
    .join(',');
  const filtering = opened && Boolean(query.trim());

  useLayoutEffect(() => {
    if (!opened) {
      if (restoreFocus.current) trigger.current?.focus();
      restoreFocus.current = false;
      return;
    }
    input.current?.focus();
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        field.current?.contains(target) ||
        results.current?.contains(target) ||
        trigger.current?.contains(target)
      )
        return;
      setOpened(false);
      setQuery('');
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      restoreFocus.current = true;
      setOpened(false);
      setQuery('');
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [opened]);

  useEffect(() => {
    setResult({ hits: [], errors: [] });
    setError('');
    if (!opened || !query.trim()) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void window.yuantu
        .projects({ type: 'search', query })
        .then((reply) => {
          if (!live) return;
          if (reply.ok) {
            setResult(reply.search ?? { hits: [], errors: [] });
            setSearchedRegistry(reply.registry);
          } else setError(reply.error);
        })
        .catch((failure: unknown) => {
          if (live) setError(String(failure));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [opened, query, workspaceKey]);

  const close = (): void => {
    restoreFocus.current = true;
    setOpened(false);
    setQuery('');
  };
  const searchRegistry = searchedRegistry ?? registry;
  const grouped = new Map<string, ProjectSessionSearch['hits']>();
  for (const hit of result.hits) {
    const hits = grouped.get(hit.workspaceId) ?? [];
    hits.push(hit);
    grouped.set(hit.workspaceId, hits);
  }
  return (
    <>
      <div className="project-group-header">
        <div className="project-group-controls" hidden={opened}>
          {heading}
          <button
            ref={trigger}
            id="open-session-search"
            type="button"
            className="project-search-button"
            aria-label={t('projects.search')}
            data-sidebar-tooltip={t('projects.search')}
            aria-controls="session-search"
            aria-expanded={opened}
            onClick={() => {
              setQuery('');
              setOpened(true);
            }}
          >
            <Icon kind="search" />
          </button>
          {addAction}
        </div>
        <div ref={field} className="project-search-field" hidden={!opened}>
          <Icon kind="search" />
          <input
            ref={input}
            id="session-search"
            className="project-search-input"
            type="search"
            maxLength={200}
            value={query}
            aria-label={t('projects.search')}
            placeholder={t('projects.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            id="clear-session-search"
            type="button"
            aria-label={t('ui.closeSearch')}
            data-sidebar-tooltip={t('ui.closeSearch')}
            onClick={close}
          >
            <Icon kind="close" />
          </button>
        </div>
      </div>
      <div
        ref={results}
        className="project-scroll project-search-results"
        hidden={!filtering}
        aria-busy={loading}
      >
        {error ? <p role="alert">{error}</p> : null}
        {result.errors.map((failure) => (
          <p key={failure.workspaceId} role="alert">
            {t('projects.searchFailed', {
              name:
                searchRegistry?.workspaces.find((entry) => entry.id === failure.workspaceId)
                  ?.displayName ?? failure.workspaceId,
            })}
          </p>
        ))}
        {loading ? (
          <p role="status">{t('projects.searching')}</p>
        ) : query.trim() && !error && !result.hits.length ? (
          <p id="session-search-empty" role="status">
            {t('ui.noMatchingSessions')}
          </p>
        ) : null}
        {searchRegistry?.workspaces
          .filter((workspace) => !workspace.removed)
          .map((workspace) => {
            const hits = grouped.get(workspace.id) ?? [];
            if (!hits.length) return null;
            const active = registry?.activeWorkspaceId === workspace.id;
            return (
              <section key={workspace.id} className={`project-row${active ? ' selected' : ''}`}>
                <div className="project-row-header project-search-project">
                  <Icon kind="folder-open" />
                  <span className="project-search-project-name" title={workspace.canonicalPath}>
                    {workspace.displayName}
                  </span>
                </div>
                {hits.map((hit) => (
                  <button
                    key={hit.sessionId}
                    type="button"
                    className={`project-search-result${active && workspace.lastSessionId === hit.sessionId ? ' selected' : ''}`}
                    disabled={!canChange || selecting}
                    onClick={() => {
                      setSelecting(true);
                      void openSession(hit.workspaceId, hit.sessionId)
                        .then((ok) => {
                          if (ok) {
                            restoreFocus.current = true;
                            setOpened(false);
                            setQuery('');
                          } else setError(t('projects.openFailed'));
                        })
                        .catch((failure: unknown) => setError(String(failure)))
                        .finally(() => setSelecting(false));
                    }}
                  >
                    <span>{hit.title || t('ui.untitledSession')}</span>
                    {hit.createdAt ? <small>{sessionAge(hit.createdAt, locale())}</small> : null}
                  </button>
                ))}
              </section>
            );
          })}
        {[...grouped.values()].some((hits) => hits.length >= 50) ? (
          <p className="project-search-hint">{t('projects.searchHint')}</p>
        ) : null}
      </div>
      <div className="project-default-list" hidden={filtering}>
        {children}
      </div>
    </>
  );
}
