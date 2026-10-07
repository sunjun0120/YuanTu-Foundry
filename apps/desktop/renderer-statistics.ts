import type { SessionSnapshot, StatisticsDelta } from '../../packages/client/session-controller.ts';
import { emptyStatistics } from '../../packages/protocol/statistics.ts';
import type { SessionStatistics } from '../../packages/protocol/statistics.ts';
import { locale, onLocaleChange } from './i18n.ts';
import { formatExactTokens, formatTokens } from './token-format.ts';

/**
 * The two readings under the composer, and the two panels behind them.
 *
 * Both surfaces are DSH's, copied rather than reinvented: the same figures, in the same order, under the same
 * names, with the same number formatting — because these numbers are read next to DSH's own and two answers to
 * "how fast did this session run" would be worse than one. What is *not* copied is content DSH does not show:
 * no explanatory footnotes, no per-panel caveats, no third pill, no occupancy bar. A reader who wants the
 * reasoning reads the code that computes the figures, which is where it belongs.
 *
 * The aggregation itself (what counts as a step, which spans the model time covers, how the cache hit is
 * divided) lives in `packages/protocol/statistics.ts` and the run that fills it in, not here: this module only
 * formats.
 */
export function setupStatistics() {
  const host = document.getElementById('composer-statistics')!;
  const text = (zh: string, en: string) => (locale() === 'en-US' ? en : zh);
  const icons = [
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14a8 8 0 1 1 14 0M10 11l4-5"/><circle cx="10" cy="11" r="1.4"/></svg>',
    '<svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="4" rx="6" ry="2.5"/><path d="M4 4v11c0 3.3 12 3.3 12 0V4M4 9c0 3.3 12 3.3 12 0"/></svg>',
  ];
  /** Row labels, per panel, in the order DSH prints them. */
  const labels = [
    [
      ['模型用时', 'LLM time'],
      ['工具调用用时', 'Tool time'],
      ['首 token 平均（TTFT）', 'Avg time to first token (TTFT)'],
      ['输出速度（TPS）', 'Tokens per second (TPS)'],
    ],
    [
      ['缓存命中', 'Cache hit'],
      ['未缓存输入', 'Uncached input'],
      ['缓存读取', 'Cached input'],
      ['缓存写入', 'Cache write'],
      ['输出', 'Output'],
    ],
  ];
  const titles = [
    ['会话统计', 'Session statistics'],
    ['Token 用量', 'Token usage'],
  ];
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
    /**
     * One label/value pair per row the schema can print, kept rather than rebuilt.
     *
     * Which rows are *in* the list is decided per render and the pairs are moved into it then, so a row a
     * session has no figure for is absent from the panel exactly as it is in DSH — not an empty line, and not
     * a zero standing in for a measurement nobody took.
     */
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

  const exactCount = (value: number) => formatExactTokens(value) + ' tok';
  /**
   * Compact duration, DSH's own two-step shape: tenths of a second under a minute, whole minutes and seconds
   * above it. `4.2秒` / `102分35秒`, never `102 分 35 秒` — the space is the part a reader notices.
   */
  function duration(ms: number) {
    const seconds = ms / 1000;
    if (seconds < 60)
      return text(`${Math.round(seconds * 10) / 10}秒`, `${Math.round(seconds * 10) / 10}s`);
    const whole = Math.round(seconds);
    return text(
      `${Math.floor(whole / 60)}分${whole % 60}秒`,
      `${Math.floor(whole / 60)}m${whole % 60}s`,
    );
  }
  /** Whole tokens from ten up, one decimal below: `180 tok/s`, `4.2 tok/s`. */
  function formatTokensPerSecond(tps: number): string {
    const clamped = Math.max(0, tps);
    return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
  }
  /**
   * The prompt-side total the cache hit is a share of: every billing bucket, not just the uncached part.
   *
   * `inputTokens` is what the provider billed, so it already is the sum of the three buckets — reading it
   * directly is the same number DSH's `billedInputTokens` adds up, and the total the pill shows is that plus
   * the output.
   */
  const billedInputTokens = (stats: SessionStatistics) => stats.inputTokens;
  /**
   * Cache-hit share of the prompt, DSH's rounding rule included.
   *
   * An ordinary integer percentage, except that a partial hit never *displays* as a full one: when rounding
   * would print 100 for a session that still missed a token, the precision is extended just far enough to
   * show the miss. A true 100% is printed as 100, and a session with no billed prompt has no share at all.
   */
  function cacheHitPercent(stats: SessionStatistics): string | null {
    const promptTokens = billedInputTokens(stats);
    if (promptTokens === 0) return null;
    const cacheReadTokens = stats.cachedInputTokens;
    const missed = promptTokens - cacheReadTokens;
    if (missed === 0) return '100';
    const rounded = Math.round((cacheReadTokens / promptTokens) * 100);
    if (rounded < 100) return String(rounded);
    // Rounding already said "full" while a token is missing, so print enough nines to show the miss.
    let places = 1;
    let gap = missed * 200;
    const denominatorTens = Math.floor(promptTokens / 10);
    while (gap <= denominatorTens) {
      gap *= 10;
      places += 1;
    }
    const denominatorOnes = promptTokens % 10;
    let loss = 5;
    for (let candidate = 1; candidate < 5; candidate += 1) {
      const factor = candidate * 2 + 1;
      if (gap <= factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)) {
        loss = candidate;
        break;
      }
    }
    return `99.${'9'.repeat(places - 1)}${10 - loss}`;
  }
  /**
   * The prompt tokens that were neither read from nor written to the cache.
   *
   * Both cache buckets are parts of the billed input, so both have to come out: subtracting only the read
   * bucket counted a cache write as "uncached input" and made the row disagree with `缓存命中` beside it.
   */
  function uncachedInputTokens(stats: SessionStatistics): number {
    return stats.inputTokens - stats.cachedInputTokens - stats.cacheWriteInputTokens;
  }
  function render() {
    const stats = current?.statistics ?? emptyStatistics();
    const total = billedInputTokens(stats) + stats.outputTokens;
    const cacheHit = cacheHitPercent(stats);
    const tps =
      stats.decodeMs > 0 && stats.decodeKnown === true
        ? formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)) + ' tok/s'
        : null;
    const counts = text(
      `${stats.turns} 轮 ${stats.steps} 步`,
      `${stats.turns} turns ${stats.steps} steps`,
    );
    // Every figure a panel prints is optional. A session with no step and no token has no reading at all, so
    // neither pill is on screen; a session with steps but no timed figure keeps its counts as a plain reading
    // instead of a button over an empty dialog, which is DSH's rule and the honest one.
    const timed =
      stats.modelMs > 0 || stats.toolMs > 0 || stats.firstTokenCount > 0 || stats.decodeMs > 0;
    items[0]!.wrapper.hidden = stats.steps === 0;
    items[0]!.openable = timed;
    items[1]!.wrapper.hidden = total === 0;
    items[1]!.openable = true;
    items[0]!.summary.textContent = counts + (tps === null ? '' : ' · ' + tps);
    items[0]!.button.setAttribute('aria-label', items[0]!.summary.textContent);
    items[1]!.summary.textContent =
      formatTokens(total) +
      ' tok' +
      (cacheHit === null ? '' : ' · ' + text(`缓存命中 ${cacheHit}%`, `Cache hit ${cacheHit}%`));
    items[1]!.button.setAttribute('aria-label', items[1]!.summary.textContent);
    items.forEach((item, index) => {
      const title = text(...(titles[index]! as [string, string]));
      item.panel.setAttribute('aria-label', title);
      item.title.textContent = title;
    });
    // Only the usage panel has a headline value: the time panel's own total is its pill.
    items[0]!.total.textContent = '';
    items[1]!.total.textContent = exactCount(total);
    const rows = [
      [
        stats.modelMs > 0 ? duration(stats.modelMs) : '',
        stats.toolMs > 0 ? duration(stats.toolMs) : '',
        stats.firstTokenCount > 0 ? duration(stats.firstTokenMs / stats.firstTokenCount) : '',
        stats.decodeMs > 0 ? (tps ?? text('未知', 'Unknown')) : '',
      ],
      [
        cacheHit === null ? '' : cacheHit + '%',
        exactCount(uncachedInputTokens(stats)),
        exactCount(stats.cachedInputTokens),
        stats.cacheWriteInputTokens !== 0 ? exactCount(stats.cacheWriteInputTokens) : '',
        exactCount(stats.outputTokens),
      ],
    ];
    items.forEach((item, index) => {
      const shown: HTMLElement[] = [];
      item.values.forEach((row, rowIndex) => {
        const value = rows[index]![rowIndex]!;
        if (value === '') return;
        row.name.textContent = text(...(labels[index]![rowIndex]! as [string, string]));
        row.value.textContent = value;
        shown.push(row.name, row.value);
      });
      item.body.replaceChildren(...shown);
    });
    // A pill that just went off screen, or lost the figure its panel is made of, must not leave its dialog
    // behind: the panel is a reading of the pill, so it goes when the pill does. The row goes with the last
    // pill too — reserved empty space under the composer is something a reader keeps looking at for nothing.
    if (opened >= 0 && (items[opened]!.wrapper.hidden || !items[opened]!.openable)) close();
    host.hidden = items[0]!.wrapper.hidden && items[1]!.wrapper.hidden;
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
     * Usage and activity, delivered without a snapshot. Only the numbers changed, so patching them and
     * repainting two popovers is the whole cost of the update.
     */
    delta(delta: StatisticsDelta) {
      if (!current || current.sessionId !== delta.sessionId) return;
      current = { ...current, statistics: delta.statistics, statisticsActivity: delta.activity };
      render();
    },
  };
}
