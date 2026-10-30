/**
 * The summary popover in the header: the MCP calls of the latest turn.
 *
 * The readings come from `summary-model.ts`. The entry is a click toggle, unlike the hover-revealed background list:
 * it sits at the column's right edge, next to the workspace opener, where a hover panel would open every time the
 * pointer travels to that opener. A click elsewhere closes it, and Escape closes it and returns focus to the entry.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { ReadableStore } from '../stores.ts';
import { summaryView, type SummaryCall } from './summary-model.ts';

export interface SummaryState {
  snapshot: CarrierSnapshot | null;
  open: boolean;
}

function SummaryIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <path d="M12 7h8M12 17h8" />
    </svg>
  );
}

function CallRow({ call }: { call: SummaryCall }): ReactNode {
  const server = call.server ?? t('summary.builtinServer');
  return (
    <li className="summary-call" data-status={call.status}>
      <span
        className="summary-call-dot"
        data-status={call.status}
        role="img"
        aria-label={t(`summary.status.${call.status}`)}
        title={t(`summary.status.${call.status}`)}
      />
      <div className="summary-call-body">
        <div className="summary-call-head">
          <span className="summary-call-tool" translate="no">
            {call.tool}
          </span>
          <span className="summary-call-server" translate="no">
            {server}
          </span>
        </div>
        {call.args ? (
          <span className="summary-call-args" title={call.args} translate="no">
            {call.args}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function SummaryPanel({
  store,
  setOpen,
}: {
  store: ReadableStore<SummaryState>;
  setOpen(open: boolean): void;
}): ReactNode {
  useLocale();
  const state = useReadable(store);
  const current = summaryView(state.snapshot);
  const popover = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = state.open && current.visible;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !popover.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || popover.current?.hidden) return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [setOpen]);

  useEffect(() => {
    if (!current.visible) setOpen(false);
  }, [current.visible, setOpen]);

  return (
    <div className="summary-anchor">
      <button
        ref={button}
        id="open-summary"
        className="open-summary"
        type="button"
        aria-expanded={open}
        aria-controls="summary-popover"
        aria-label={t('summary.title')}
        title={t('summary.title')}
        hidden={!current.visible}
        onClick={() => setOpen(!open)}
      >
        <SummaryIcon />
      </button>
      <section
        ref={popover}
        id="summary-popover"
        className="summary-popover"
        aria-label={t('summary.title')}
        hidden={!open}
      >
        <h2 className="summary-title">{t('summary.title')}</h2>
        <div className="summary-section">
          <h3 className="summary-section-title">
            {t('summary.mcpCalls')}
            {current.calls.length ? (
              <span className="summary-count">
                {current.failed
                  ? t('summary.countWithFailed', {
                      count: current.calls.length,
                      failed: current.failed,
                    })
                  : t('summary.count', { count: current.calls.length })}
              </span>
            ) : null}
          </h3>
          {current.calls.length === 0 ? (
            <p className="summary-empty">{t('summary.empty')}</p>
          ) : (
            <ol className="summary-calls">
              {current.calls.map((call) => (
                <CallRow key={call.id} call={call} />
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
