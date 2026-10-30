import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import type { DeliverableRow } from './session-panels-model.ts';

function DeliverableIcon({ kind }: { kind: DeliverableRow['kind'] }): ReactNode {
  return (
    <span className="deliverable-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'html' ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4" ry="9" />
            <path d="M3 12h18" />
          </>
        ) : (
          <>
            <path d="M6 2h8l5 5v15H6Zm8 0v6h5M9 12h7m-7 4h7" />
          </>
        )}
      </svg>
    </span>
  );
}

/** A native stretched button opens the card; the folder button is its sibling, never a nested control. */
export function DeliverableCard({
  row,
  open,
  reveal,
}: {
  row: DeliverableRow;
  open?: (path: string) => void;
  reveal?: (path: string) => void;
}): ReactNode {
  return (
    <li
      className="deliverable"
      data-path={row.path}
      data-kind={row.kind}
      data-openable={open ? '' : undefined}
    >
      {open ? (
        <button
          type="button"
          className="deliverable-open"
          title={row.path}
          aria-label={`${t('ui.viewInSidebar')}: ${row.label} (${row.path})`}
          onClick={() => open(row.path)}
        />
      ) : null}
      <DeliverableIcon kind={row.kind} />
      <div className="deliverable-content">
        <strong className="deliverable-title" translate="no">
          {row.label}
        </strong>
        <div className="deliverable-meta">
          <span className="deliverable-format" translate="no">
            {row.format}
          </span>
          {open ? (
            <span className="deliverable-footer-action">
              <span aria-hidden="true">·</span>
              <span className="deliverable-view">{t('ui.viewInSidebar')}</span>
            </span>
          ) : null}
          {reveal ? (
            <span className="deliverable-footer-action">
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="deliverable-folder"
                aria-label={`${t('ui.openContainingFolder')}: ${row.path}`}
                onClick={() => reveal(row.path)}
              >
                {t('ui.openContainingFolder')}
              </button>
            </span>
          ) : null}
        </div>
      </div>
      {open ? (
        <svg
          className="deliverable-chevron"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m8 6 4 4-4 4" />
        </svg>
      ) : null}
    </li>
  );
}
