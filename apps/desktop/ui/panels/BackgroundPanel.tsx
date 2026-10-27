/**
 * The background jobs popover in the header.
 *
 * The readings come from `background-model.ts`; this component owns the hover/focus/outside-click rules: entering
 * the anchor opens it, leaving it closes after a grace period so the pointer can cross the gap, a click anywhere
 * else closes it, and Escape closes it and returns focus to the entry. The stop control exists only on a running
 * job — a finished job has nothing to stop.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { locale, t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { ReadableStore } from '../stores.ts';
import { backgroundView } from './background-model.ts';

export interface BackgroundState {
  snapshot: CarrierSnapshot | null;
  open: boolean;
}

function JobCard({
  row,
  invoke,
}: {
  row: ReturnType<typeof backgroundView>['rows'][number];
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}): ReactNode {
  const stop = useRef<HTMLButtonElement>(null);
  return (
    <div className="background-card" data-job-id={row.id}>
      <div className="background-card-header">
        <span
          className={`background-dot subagent-row-dot ${row.status}`}
          data-state={row.indicator}
          title={t(row.statusLabelKey)}
          role="img"
          aria-label={t(row.statusLabelKey)}
        />
        <span className="background-shell">{row.shell ?? t('background.commandLabel')}</span>
        <span className="background-command" title={row.command}>
          {row.command}
        </span>
        <span className={`background-status ${row.statusClass}`}>
          {row.exitLabel ?? t(row.statusLabelKey)}
        </span>
        <span className="background-duration">{row.duration}</span>
        {row.stoppable ? (
          <button
            ref={stop}
            type="button"
            className="background-stop"
            title={t('background.stop')}
            onClick={() => {
              const button = stop.current;
              if (button) button.disabled = true;
              void (async () => {
                try {
                  await invoke({
                    type: 'stopBackground',
                    id: row.id,
                    sessionId: row.sessionId,
                  });
                } catch {
                  // The invoker presents IPC errors; the control must remain available for retry.
                } finally {
                  if (button) button.disabled = false;
                }
              })();
            }}
          >
            {t('background.stop')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BackgroundPanel({
  store,
  invoke,
  setOpen,
}: {
  store: ReadableStore<BackgroundState>;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  setOpen(open: boolean): void;
}): ReactNode {
  useLocale();
  const state = useReadable(store);
  // `useLocale` above subscribes this component; `locale()` is the language the rest of the window is using.
  const current = backgroundView(state.snapshot, locale());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = state.open && current.visible;
  /**
   * The popover's DOM is patched with the state, not after it. A click is answered in the same turn it arrives —
   * the window's own smoke reads hidden/ria-expanded immediately — and React's render then agrees with it.
   */
  const syncOpen = useCallback(
    (next: boolean): void => {
      if (popover.current) popover.current.hidden = !next;
      button.current?.setAttribute('aria-expanded', String(next));
      setOpen(next);
    },
    [setOpen],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !popover.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        syncOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || popover.current?.hidden) return;
      syncOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(closeTimer.current);
    };
  }, [setOpen, syncOpen]);

  useEffect(() => {
    if (!current.visible) setOpen(false);
  }, [current.visible, setOpen]);

  return (
    <div
      ref={anchor}
      className="background-anchor"
      onPointerEnter={() => {
        clearTimeout(closeTimer.current);
        if (current.visible) syncOpen(true);
      }}
      onPointerLeave={() => {
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => syncOpen(false), 180);
      }}
    >
      <button
        ref={button}
        id="open-background"
        className="open-background"
        type="button"
        aria-expanded={open}
        aria-controls="background-popover"
        hidden={!current.visible}
        data-status={current.overall}
        title={t(current.statusLabelKey)}
        aria-label={current.ariaLabel}
        onClick={() => syncOpen(true)}
      >
        <span id="background-label" className="background-label">
          {current.label}
        </span>
      </button>
      <section
        ref={popover}
        id="background-popover"
        className="background-popover"
        aria-label={t('background.title')}
        hidden={!open}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
      >
        <div id="background-list" className="background-list">
          {current.rows.length === 0 ? (
            <p className="background-empty">{t('background.empty')}</p>
          ) : (
            current.rows.map((row) => <JobCard key={row.id} row={row} invoke={invoke} />)
          )}
        </div>
      </section>
    </div>
  );
}
