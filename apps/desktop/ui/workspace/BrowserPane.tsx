/**
 * One browser tab's Host-side chrome: address bar, history controls, start/error/crash pages.
 *
 * The guest is a native `WebContentsView` owned by the main process; this component only measures the
 * `.browser-surface` rectangle, asks main to lay the view out there, and withdraws it whenever the tab is not the
 * active panel surface or a Host overlay would be covered. The guest never receives Host markup.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserCommand, BrowserState } from '../../browser-contract.ts';
import { resolveBrowserAddress } from '../../browser-url.ts';
import { t } from '../../i18n.ts';

function overlayOpen(): boolean {
  for (const node of document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], [role="listbox"]',
  )) {
    // The workspace panel itself becomes a dialog in fullscreen; its guest is inside it, not behind it.
    if (node.closest('#workspace-panel')) continue;
    if (node.closest('[hidden], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (node.getClientRects().length) return true;
  }
  return false;
}

export function BrowserPane({ id, state }: { id: string; state: BrowserState }): ReactNode {
  const surface = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(state.url);
  const [addressError, setAddressError] = useState('');
  const frame = useRef(0);

  useEffect(() => setAddress(state.url), [state.url]);
  useEffect(() => {
    if (!state.started) addressInput.current?.focus();
  }, [state.started]);

  const send = useCallback((command: BrowserCommand): void => {
    void window.yuantu
      .browser(command)
      .then((reply) => {
        if (!reply.ok) setAddressError(reply.error);
      })
      .catch((error: unknown) =>
        setAddressError(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  const layout = useCallback(() => {
    const node = surface.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const hidden =
      node.closest('[hidden]') !== null || document.body.dataset.workspaceView === 'closed';
    const visible = !hidden && state.started && !state.error && !state.crashed && !overlayOpen();
    send({
      type: 'layout',
      id,
      bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      visible,
    });
  }, [id, send, state.started, state.error, state.crashed]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      layout();
    });
  }, [layout]);

  useEffect(() => {
    const node = surface.current;
    const observer = new ResizeObserver(schedule);
    if (node) observer.observe(node);
    window.addEventListener('resize', schedule);
    window.addEventListener('yuantu-browser-layout', schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-workspace-view'],
    });
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('yuantu-browser-layout', schedule);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      send({
        type: 'layout',
        id,
        bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        visible: false,
      });
    };
  }, [id, schedule, send]);

  const submit = (): void => {
    const resolved = resolveBrowserAddress(address);
    if (!resolved) {
      setAddressError(t('browser.unsafeAddress'));
      return;
    }
    setAddressError('');
    setAddress(resolved);
    send({ type: 'navigate', id, url: resolved });
  };

  return (
    <section id={`browser-${id}`} className="browser-pane" data-browser-id={id}>
      <div className="browser-toolbar">
        <button
          type="button"
          aria-label={t('browser.back')}
          title={t('browser.back')}
          disabled={!state.canGoBack}
          onClick={() => send({ type: 'back', id })}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={t('browser.forward')}
          title={t('browser.forward')}
          disabled={!state.canGoForward}
          onClick={() => send({ type: 'forward', id })}
        >
          →
        </button>
        <button
          type="button"
          aria-label={t(state.loading ? 'browser.stop' : 'browser.reload')}
          title={t(state.loading ? 'browser.stop' : 'browser.reload')}
          data-loading={state.loading ? 'true' : undefined}
          onClick={() => send({ type: state.loading ? 'stop' : 'reload', id })}
        >
          {state.loading ? '×' : '⟳'}
        </button>
        <input
          ref={addressInput}
          className="browser-address"
          aria-label={t('browser.addressLabel')}
          placeholder={t('browser.addressPlaceholder')}
          value={address}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => {
            setAddress(event.target.value);
            setAddressError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setAddress(state.url);
              setAddressError('');
              return;
            }
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="button"
          aria-label={t('browser.openExternal')}
          title={t('browser.openExternal')}
          disabled={!state.url}
          onClick={() => send({ type: 'open-external', id, url: state.url })}
        >
          ↗
        </button>
      </div>
      {addressError ? (
        <p className="browser-note browser-address-error" role="alert">
          {addressError}
        </p>
      ) : null}
      {state.notice ? (
        <p className="browser-note browser-notice" role="status">
          {t(
            state.notice === 'download-blocked'
              ? 'browser.downloadUnsupported'
              : 'browser.postPopupUnsupported',
          )}
        </p>
      ) : null}
      {state.crashed ? (
        <div className="browser-status" data-browser-crashed>
          <h2>{t('browser.crashed')}</h2>
          <button type="button" onClick={() => send({ type: 'reload', id })}>
            {t('browser.reopen')}
          </button>
        </div>
      ) : state.error ? (
        <div className="browser-status" data-browser-error>
          <h2>{t('browser.errorTitle')}</h2>
          <p>{state.error.description}</p>
          <p className="browser-error-code">{t('browser.errorCode', { code: state.error.code })}</p>
          <p className="browser-error-url" translate="no">
            {state.error.url}
          </p>
          <div className="browser-status-actions">
            <button type="button" onClick={() => send({ type: 'reload', id })}>
              {t('browser.retry')}
            </button>
            <button
              type="button"
              onClick={() => send({ type: 'open-external', id, url: state.error!.url })}
            >
              {t('browser.openExternal')}
            </button>
          </div>
        </div>
      ) : !state.started ? (
        <div className="browser-status" data-browser-start>
          <h2>{t('browser.startTitle')}</h2>
          <p>{t('browser.startHint')}</p>
        </div>
      ) : null}
      <div ref={surface} className="browser-surface" />
    </section>
  );
}
