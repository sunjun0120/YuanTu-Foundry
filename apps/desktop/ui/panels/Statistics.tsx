/**
 * The two readings under the composer and the two popovers behind them.
 *
 * The figures and wording come from `statistics-model.ts`; this component owns the popover rules DSH has: hovering a
 * pill opens it, leaving closes after a short grace period, a click pins it, Escape or a click elsewhere closes it,
 * and the popover sits above its trigger. A pill with no timed figure keeps its counts but is not openable, so a
 * dialog over an empty reading cannot exist.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionSnapshot } from '../../../../packages/client/session-controller.ts';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { ReadableStore } from '../stores.ts';
import { statisticsView, type StatisticsPanel } from './statistics-model.ts';

const ICONS = [
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14a8 8 0 1 1 14 0M10 11l4-5"/><circle cx="10" cy="11" r="1.4"/></svg>',
  '<svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="4" rx="6" ry="2.5"/><path d="M4 4v11c0 3.3 12 3.3 12 0V4M4 9c0 3.3 12 3.3 12 0"/></svg>',
];

function StatisticsItem({
  index,
  buttonId,
  icon,
  title,
  summary,
  total,
  section,
  visible,
  open,
  onOpen,
  onClose,
  onTogglePin,
  buttonRef,
  panelRef,
}: {
  index: number;
  buttonId: string;
  icon: string;
  title: string;
  summary: string;
  total: string | null;
  section: StatisticsPanel | null;
  visible: boolean;
  open: boolean;
  onOpen(index: number): void;
  onClose(): void;
  onTogglePin(index: number): void;
  buttonRef(button: HTMLButtonElement | null): void;
  panelRef(panel: HTMLElement | null): void;
}): ReactNode {
  return (
    <div
      className="statistics-item"
      hidden={!visible}
      onPointerEnter={() => onOpen(index)}
      onPointerLeave={() => onClose()}
    >
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="statistics-trigger"
        aria-controls={`${buttonId}-panel`}
        aria-expanded={open}
        aria-label={summary}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) onOpen(index);
        }}
        onBlur={() => onClose()}
        onClick={() => onTogglePin(index)}
      >
        <span dangerouslySetInnerHTML={{ __html: icon }} />
        <span>{summary}</span>
      </button>
      <section
        ref={panelRef}
        id={`${buttonId}-panel`}
        className="statistics-popover"
        role="dialog"
        aria-label={title}
        hidden={!open || !section}
      >
        <header>
          <strong>{title}</strong>
          <strong>{total ?? ''}</strong>
        </header>
        <dl>
          {(section?.rows ?? []).map((row) => (
            <FragmentRow key={row.key} index={index} row={row} />
          ))}
        </dl>
      </section>
    </div>
  );
}

function FragmentRow({
  index,
  row,
}: {
  index: number;
  row: StatisticsPanel['rows'][number];
}): ReactNode {
  const value = index === 1 && row.key !== 'statistics.cacheHit' ? `${row.value} tok` : row.value;
  return (
    <>
      <dt>{t(row.key)}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function Statistics({ store }: { store: ReadableStore<SessionSnapshot | null> }): ReactNode {
  const lang = useLocale();
  const snapshot = useReadable(store);
  const view = statisticsView(snapshot ?? undefined, lang);
  const [opened, setOpened] = useState(-1);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const buttons = useRef<(HTMLButtonElement | null)[]>([null, null]);
  const panels = useRef<(HTMLElement | null)[]>([null, null]);
  const sections = [view.session, view.tokens];
  const visible = [view.sessionVisible, view.tokensVisible];
  const lastSession = useRef(snapshot?.sessionId);
  const stateRef = useRef({ sections, visible });
  stateRef.current = { sections, visible };

  const position = useCallback((index: number) => {
    const button = buttons.current[index];
    const panel = panels.current[index];
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rect.top - panel.offsetHeight - 8)}px`;
  }, []);

  /**
   * Patch `hidden`/`aria-expanded` in the same turn the event arrives, then let React render agree. A smoke that
   * clicks and reads immediately must see the popover it asked for.
   */
  const applyOpen = useCallback(
    (index: number | null) => {
      panels.current.forEach((panel, at) => {
        if (panel) panel.hidden = at !== index;
      });
      buttons.current.forEach((button, at) => {
        button?.setAttribute('aria-expanded', String(at === index));
      });
      setOpened(index ?? -1);
      if (index !== null) position(index);
    },
    [position],
  );

  const open = useCallback(
    (index: number) => {
      if (!stateRef.current.visible[index] || !stateRef.current.sections[index]) return;
      clearTimeout(timer.current);
      applyOpen(index);
    },
    [applyOpen],
  );

  const close = useCallback(() => {
    clearTimeout(timer.current);
    pinned.current = false;
    applyOpen(null);
  }, [applyOpen]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      const host = document.getElementById('composer-statistics');
      if (host?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && panels.current.some((panel) => panel && !panel.hidden)) {
        close();
        event.stopPropagation();
      }
    };
    const onReposition = (): void => {
      panels.current.forEach((panel, index) => {
        if (panel && !panel.hidden) position(index);
      });
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
      clearTimeout(timer.current);
    };
  }, [close, position]);

  // The host is the composer's own element, outside this portal: its hidden flag and name are synced here.
  useEffect(() => {
    const host = document.getElementById('composer-statistics');
    if (!host) return;
    host.hidden = view.hidden;
    host.setAttribute('aria-label', t('statistics.hostLabel'));
  }, [view.hidden, lang]);

  // A session switch closes the popover; a pill that loses its figure must not leave its dialog behind either.
  const sessionKey = snapshot?.sessionId;
  const sessionVisible = visible[0] ?? false;
  const tokensVisible = visible[1] ?? false;
  useEffect(() => {
    if (lastSession.current !== sessionKey) {
      lastSession.current = sessionKey;
      close();
      return;
    }
    if (!sessionVisible && !tokensVisible) close();
    else if (opened >= 0 && !(opened === 0 ? sessionVisible : tokensVisible)) close();
  }, [sessionKey, sessionVisible, tokensVisible, opened, close]);

  // The popover is measured after its rows are in the DOM, then placed above the trigger.
  useLayoutEffect(() => {
    if (opened >= 0) position(opened);
  }, [opened, snapshot, position]);

  const summaries = [view.counts, view.usage];
  const titles = [t('statistics.sessionTitle'), t('statistics.tokensTitle')];
  return (
    <>
      {[0, 1].map((index) => (
        <StatisticsItem
          key={index}
          index={index}
          buttonId={index === 0 ? 'statistics-session' : 'statistics-tokens'}
          icon={ICONS[index]!}
          title={titles[index]!}
          summary={summaries[index]!}
          total={sections[index]?.total ? `${sections[index]!.total} tok` : null}
          section={sections[index] ?? null}
          visible={visible[index]!}
          open={opened === index}
          onOpen={(at) => {
            clearTimeout(timer.current);
            if (!pinned.current) open(at);
          }}
          onClose={() => {
            if (pinned.current) return;
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              if (!pinned.current) applyOpen(null);
            }, 140);
          }}
          onTogglePin={(at) => {
            if (pinned.current && opened === at) {
              pinned.current = false;
              applyOpen(null);
            } else {
              pinned.current = true;
              open(at);
            }
          }}
          buttonRef={(button) => {
            buttons.current[index] = button;
          }}
          panelRef={(panel) => {
            panels.current[index] = panel;
          }}
        />
      ))}
    </>
  );
}
