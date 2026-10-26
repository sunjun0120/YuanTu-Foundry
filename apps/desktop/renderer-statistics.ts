/**
 * The two pills under the composer, and the two popovers behind them.
 *
 * The figures and their wording live in `ui/panels/statistics-model.ts`; this file is the legacy DOM seam around them:
 * the two triggers, hover/pin/close behaviour, positioning, and the snapshot/delta entry points the renderer calls.
 * When this surface moves to React, the model stays and this file becomes props.
 */
import type { SessionSnapshot, StatisticsDelta } from '../../packages/client/session-controller.ts';
import { locale, onLocaleChange, t } from './i18n.ts';
import { statisticsView } from './ui/panels/statistics-model.ts';

export { throughputReading } from './ui/panels/statistics-model.ts';

export function setupStatistics() {
  const host = document.getElementById('composer-statistics')!;
  const icons = [
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14a8 8 0 1 1 14 0M10 11l4-5"/><circle cx="10" cy="11" r="1.4"/></svg>',
    '<svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="4" rx="6" ry="2.5"/><path d="M4 4v11c0 3.3 12 3.3 12 0V4M4 9c0 3.3 12 3.3 12 0"/></svg>',
  ];
  /** Row keys, per panel, in the order DSH prints them. */
  const labels = [
    ['statistics.modelTime', 'statistics.toolsApprovals', 'statistics.ttft', 'statistics.tps'],
    [
      'statistics.cacheHit',
      'statistics.uncachedInput',
      'statistics.cachedInput',
      'statistics.cacheWrite',
      'statistics.output',
    ],
  ];
  const titles = ['statistics.sessionTitle', 'statistics.tokensTitle'];
  let current: SessionSnapshot | undefined;
  let opened = -1;
  let pinned = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const items = labels.map((rows, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'statistics-item';
    wrapper.hidden = true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'statistics-trigger';
    button.id = ['statistics-session', 'statistics-tokens'][index]!;
    button.innerHTML = icons[index]!;
    const summary = document.createElement('span');
    button.append(summary);
    const panel = document.createElement('section');
    panel.id = button.id + '-panel';
    panel.className = 'statistics-popover';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    const heading = document.createElement('header');
    const title = document.createElement('strong');
    const total = document.createElement('strong');
    heading.append(title, total);
    const body = document.createElement('dl');
    const values = rows.map(() => {
      const name = document.createElement('dt');
      const value = document.createElement('dd');
      return { name, value };
    });
    panel.append(heading, body);
    wrapper.append(button, panel);
    host.append(wrapper);
    wrapper.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      if (!pinned) open(index);
    });
    wrapper.addEventListener('mouseleave', () => {
      if (!pinned) closeTimer = setTimeout(close, 140);
    });
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) open(index);
    });
    button.addEventListener('blur', () => {
      if (!pinned) close();
    });
    button.addEventListener('click', () => {
      if (pinned && opened === index) {
        pinned = false;
        close();
      } else {
        pinned = true;
        open(index);
      }
    });
    return { wrapper, button, summary, panel, body, title, total, values, openable: true };
  });
  function position() {
    if (opened < 0) return;
    const { button, panel } = items[opened]!;
    const rect = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    panel.style.top = Math.max(12, rect.top - panel.offsetHeight - 8) + 'px';
  }
  function close() {
    clearTimeout(closeTimer);
    opened = -1;
    for (const item of items) {
      item.panel.hidden = true;
      item.button.setAttribute('aria-expanded', 'false');
    }
  }
  function open(index: number) {
    // A pill that is off screen, or that has no figure to open, cannot be the one a stale pointer opens.
    if (items[index]!.wrapper.hidden || !items[index]!.openable) return;
    close();
    opened = index;
    items[index]!.panel.hidden = false;
    items[index]!.button.setAttribute('aria-expanded', 'true');
    position();
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened >= 0) {
      pinned = false;
      close();
      event.stopPropagation();
    }
  });
  document.addEventListener('click', (event) => {
    if (!host.contains(event.target as Node)) {
      pinned = false;
      close();
    }
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);

  function render() {
    const view = statisticsView(current, locale());
    const sections = [view.session, view.tokens];
    items.forEach((item, index) => {
      const section = sections[index] ?? null;
      item.wrapper.hidden = index === 0 ? !view.sessionVisible : !view.tokensVisible;
      item.openable = section !== null;
      item.summary.textContent = index === 0 ? view.counts : view.usage;
      item.button.setAttribute('aria-label', item.summary.textContent ?? '');
      const title = t(titles[index]!);
      item.panel.setAttribute('aria-label', title);
      item.title.textContent = title;
      item.total.textContent = section?.total ? `${section.total} tok` : '';
      const shown: HTMLElement[] = [];
      for (const row of section?.rows ?? []) {
        const at = labels[index]!.indexOf(row.key);
        if (at < 0) continue;
        const pair = item.values[at]!;
        pair.name.textContent = t(row.key);
        pair.value.textContent =
          index === 1 && row.key !== 'statistics.cacheHit' ? `${row.value} tok` : row.value;
        shown.push(pair.name, pair.value);
      }
      item.body.replaceChildren(...shown);
    });
    // A pill that just went off screen, or lost the figure its panel is made of, must not leave its dialog behind.
    if (opened >= 0 && (items[opened]!.wrapper.hidden || !items[opened]!.openable)) close();
    host.hidden = view.hidden;
    position();
  }
  onLocaleChange(render);
  render();
  return {
    update(next: SessionSnapshot) {
      if (current?.sessionId !== next.sessionId) {
        pinned = false;
        close();
      }
      current = next;
      render();
    },
    /**
     * Usage and activity, delivered without a snapshot. Only the numbers changed, so patching them and repainting
     * two popovers is the whole cost of the update — and a delta for another session is not this reading.
     */
    delta(delta: StatisticsDelta) {
      const next = (
        current?.sessionId === delta.sessionId
          ? {
              ...current,
              statistics: delta.statistics,
              ...(delta.runStatistics !== undefined ? { runStatistics: delta.runStatistics } : {}),
              statisticsActivity: delta.activity,
            }
          : null
      ) as SessionSnapshot | null;
      if (!next) return;
      current = next;
      render();
    },
  };
}
