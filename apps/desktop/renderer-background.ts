/**
 * The background jobs card list in the header: the popover it lives in, the entry that opens it, and the one
 * line of state that decides whether the entry is offered at all.
 *
 * The entry is hidden until this window has seen a job, and that fact is remembered across restarts (the
 * storage read is optional — a window with storage disabled simply shows the entry on its first job). The
 * popover is hover/focus-revealed rather than a panel of its own, so its open/close rules are the three
 * listeners below: entering the anchor opens it, leaving it closes after a short grace period so the pointer can
 * cross the gap, and a click anywhere else closes it — the outside-click rule is asserted by the desktop smoke.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { format, locale, t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupBackgroundView(actions: {
  getState(): CarrierSnapshot | null;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}): { render(): void; close(): void } {
  let backgroundEntrySeen = false;
  try {
    backgroundEntrySeen = localStorage.getItem('yuantu.backgroundEntrySeen') === '1';
  } catch {
    /* Storage is optional. */
  }
  function render(): void {
    const list = required('background-list');
    const existing = new Map(
      Array.from(list.querySelectorAll<HTMLElement>('.background-card[data-job-id]')).map(
        (item) => [item.dataset.jobId, item] as const,
      ),
    );
    const jobs = actions.getState()?.background ?? [];
    const openBackground = required<HTMLButtonElement>('open-background');
    const backgroundPopover = required<HTMLElement>('background-popover');
    if (jobs.length && !backgroundEntrySeen) {
      backgroundEntrySeen = true;
      try {
        localStorage.setItem('yuantu.backgroundEntrySeen', '1');
      } catch {
        /* Keep it for this window. */
      }
    }
    openBackground.hidden = !backgroundEntrySeen;
    if (openBackground.hidden) backgroundPopover.hidden = true;
    openBackground.setAttribute('aria-expanded', String(!backgroundPopover.hidden));
    const runningCount = jobs.filter((job) => ['starting', 'running'].includes(job.status)).length;
    required('background-label').textContent = format(
      t(runningCount ? 'background.runningCount' : 'background.totalCount'),
      { count: runningCount || jobs.length },
    );
    if (!jobs.length) required('background-label').textContent = t('background.title');
    if (!jobs.length) {
      list.replaceChildren(node('p', t('background.empty'), 'background-empty'));
      return;
    }
    list.querySelector('.background-empty')?.remove();
    const statusLabel = (status: string) => t(`background.${status}`);
    const elapsed = (createdAt: string, finishedAt?: string): string => {
      const start = Date.parse(createdAt);
      const end = finishedAt ? Date.parse(finishedAt) : Date.now();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
      const total = Math.floor(Math.max(0, end - start) / 1000);
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      return locale() === 'en-US'
        ? `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${seconds}s`
        : `${hours ? `${hours}小时` : ''}${hours || minutes ? `${minutes}分` : ''}${seconds}秒`;
    };
    for (const [index, job] of jobs.entries()) {
      let card = existing.get(job.id);
      if (!card) {
        card = node('div', '', 'background-card');
        card.dataset.jobId = job.id;
        const header = node('div', '', 'background-card-header');
        header.append(
          node('span', '', 'background-dot'),
          node('span', '', 'background-shell'),
          node('span', '', 'background-command'),
          node('span', '', 'background-status'),
          node('span', '', 'background-duration'),
        );
        card.append(header);
      }
      const header = card.querySelector<HTMLElement>('.background-card-header')!;
      const shell = /^(pwsh|powershell|bash|zsh|cmd|sh)(?:\.exe)?(?=\s|$)/i.exec(
        job.command.trim(),
      )?.[1];
      const command = header.querySelector<HTMLElement>('.background-command')!;
      command.textContent = job.command;
      command.title = job.command;
      const finished = !['starting', 'running'].includes(job.status);
      header.querySelector<HTMLElement>('.background-dot')!.className =
        `background-dot ${job.status}`;
      header.querySelector<HTMLElement>('.background-shell')!.textContent =
        shell ?? t('background.commandLabel');
      const status = header.querySelector<HTMLElement>('.background-status')!;
      status.textContent =
        job.status !== 'cancelled' && job.exitCode !== null
          ? format(t('background.exitCodeValue'), { code: job.exitCode })
          : statusLabel(job.status);
      status.className = `background-status ${job.status}`;
      header.querySelector<HTMLElement>('.background-duration')!.textContent =
        !finished || job.finishedAt ? elapsed(job.createdAt, job.finishedAt) : '—';
      /**
       * The way out of a running job, on the line it belongs to.
       *
       * It is revealed by the row's own hover or focus: a popover listing
       * seventeen jobs needs the command and the outcome on every line and a column of buttons on none of
       * them, and the one job somebody wants to stop is the one their pointer is already on. A finished job
       * has nothing to stop, so it gets no button at all — an empty control is worse than no control.
       */
      const previousStop = header.querySelector<HTMLButtonElement>('.background-stop');
      if (finished) previousStop?.remove();
      else if (!previousStop) {
        const stop = node('button', t('background.stop'), 'background-stop');
        stop.type = 'button';
        stop.title = t('background.stop');
        stop.addEventListener('click', () => {
          stop.disabled = true;
          void actions.invoke({ type: 'stopBackground', id: job.id, sessionId: job.sessionId });
        });
        header.append(stop);
      }
      const current = list.children[index];
      if (current !== card) list.insertBefore(card, current ?? null);
    }
    for (const [id, card] of existing) if (!jobs.some((job) => job.id === id)) card.remove();
  }

  const backgroundAnchor = document.querySelector<HTMLElement>('.background-anchor')!;
  let backgroundCloseTimer: ReturnType<typeof setTimeout> | undefined;
  function open(): void {
    if (required<HTMLButtonElement>('open-background').hidden) return;
    clearTimeout(backgroundCloseTimer);
    const backgroundPopover = required<HTMLElement>('background-popover');
    backgroundPopover.hidden = false;
    required('open-background').setAttribute('aria-expanded', 'true');
  }
  function close(): void {
    clearTimeout(backgroundCloseTimer);
    required('background-popover').hidden = true;
    required('open-background').setAttribute('aria-expanded', 'false');
  }
  backgroundAnchor.addEventListener('pointerenter', open);
  required('background-popover').addEventListener('pointerenter', () =>
    clearTimeout(backgroundCloseTimer),
  );
  backgroundAnchor.addEventListener('pointerleave', () => {
    clearTimeout(backgroundCloseTimer);
    backgroundCloseTimer = setTimeout(close, 180);
  });
  required('open-background').addEventListener('click', open);
  document.addEventListener('pointerdown', (event) => {
    const backgroundPopover = required<HTMLElement>('background-popover');
    if (
      !backgroundPopover.contains(event.target as Node) &&
      !required('open-background').contains(event.target as Node)
    ) {
      close();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !required('background-popover').hidden) {
      close();
      required('open-background').focus();
    }
  });
  return { render, close };
}
