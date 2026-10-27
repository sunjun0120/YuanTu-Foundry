import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../../../../packages/protocol/index.ts';
import { locale, t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { userMessageText } from '../../renderer-messages.ts';

export function MessageTime({ message }: { message: Message }): ReactNode {
  useLocale();
  const date = message.role === 'user' && message.createdAt ? new Date(message.createdAt) : null;
  const valid = date && Number.isFinite(date.getTime());
  return (
    <time
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? date.toLocaleString(locale()) : t('ui.sendTimeUnavailable')}
    >
      {valid
        ? date.toLocaleTimeString(locale(), {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          })
        : '—'}
    </time>
  );
}

export function MessageCopy({
  message,
  copy,
}: {
  message: Message;
  copy(text: string): Promise<void>;
}): ReactNode {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'ui.copied' | 'ui.copyFailed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    clearTimeout(timer.current);
    let result: 'ui.copied' | 'ui.copyFailed' = 'ui.copied';
    try {
      await copy(userMessageText(message));
    } catch {
      result = 'ui.copyFailed';
    }
    if (!alive.current) return;
    setBusy(false);
    setFeedback(result);
    timer.current = setTimeout(() => setFeedback(null), 1600);
  };
  return (
    <span className="user-message-actions">
      <span className="user-copy-feedback" role="status">
        {feedback ? t(feedback) : ''}
      </span>
      <button
        type="button"
        className="copy-user-message"
        title={t('ui.copyMessage')}
        aria-label={t('ui.copyMessage')}
        disabled={busy}
        onClick={() => void submit()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="4" y="6" width="10" height="11" rx="2" />
          <path d="M7 6V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v6a2 2 0 0 1-2 2h-1" />
        </svg>
      </button>
    </span>
  );
}

export function MessageExtras({
  message,
  render,
}: {
  message: Message;
  render(message: Message): HTMLElement[];
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const lang = useLocale();
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    container.replaceChildren(...render(message));
    return () => container.replaceChildren();
  }, [message, render, lang]);
  return <div ref={host} />;
}
