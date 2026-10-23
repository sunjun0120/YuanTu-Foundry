import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from 'node:perf_hooks';

/** What the Host was doing when its event loop stalled, so a stall can be attributed rather than only counted. */
export interface LoopActivity {
  /** Sessions holding a run. */
  sessions: string[];
  /** Operations outside a run (undo, verification, import, compaction …) in progress. */
  operations: number;
  /** Methods of the requests being served. */
  requests: string[];
}

export interface LoopStall extends LoopActivity {
  at: string;
  durationMs: number;
}

export interface EventLoopHealth {
  /** Event loop delay since the monitor started, in milliseconds. */
  delay: { p50: number; p99: number; max: number; mean: number };
  /** Share of wall time the loop was busy over the last completed window, 0–1. */
  utilization: number;
  thresholdMs: number;
  /** The most recent stalls, newest last. */
  stalls: LoopStall[];
}

export interface EventLoopMonitorOptions {
  /** A probe that fires this much later than scheduled counts as a stall. */
  thresholdMs?: number;
  /** How often the probe is scheduled. */
  probeMs?: number;
  /** The window `utilization` is measured over. */
  windowMs?: number;
  activity: () => LoopActivity;
  /** Where a stall is reported; stderr by default. */
  report?: (stall: LoopStall) => void;
}

export const DEFAULT_STALL_THRESHOLD_MS = 200;
const DEFAULT_PROBE_MS = 250;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_STALLS = 20;

const ms = (nanoseconds: number): number => Math.round(nanoseconds / 1e4) / 100;

/**
 * Watches the Host's one JS thread.
 *
 * Every session, approval and Stop shares this thread, so a synchronous stretch in one session — a large query, a
 * directory walk, a long serialization — is a pause for all of them. Two instruments, because they answer different
 * questions: the delay histogram says how bad the loop is overall, and the late probe says *when* a stall happened,
 * which is the only moment the Host can still say what it was doing. Both timers are unref'd: watching the loop is
 * never a reason for the process to stay alive.
 */
export class EventLoopMonitor {
  private readonly thresholdMs: number;
  private readonly probeMs: number;
  private readonly windowMs: number;
  private readonly options: EventLoopMonitorOptions;
  private histogram: IntervalHistogram | undefined;
  private probe: ReturnType<typeof setInterval> | undefined;
  private window: ReturnType<typeof setInterval> | undefined;
  private expected = 0;
  private windowStart: EventLoopUtilization | undefined;
  private utilization = 0;
  private readonly stalls: LoopStall[] = [];

  constructor(options: EventLoopMonitorOptions) {
    this.options = options;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.probeMs = options.probeMs ?? DEFAULT_PROBE_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  start(): void {
    if (this.probe) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.windowStart = performance.eventLoopUtilization();
    this.expected = performance.now() + this.probeMs;
    this.probe = setInterval(() => {
      const now = performance.now();
      this.observe(now - this.expected);
      this.expected = now + this.probeMs;
    }, this.probeMs);
    this.probe.unref?.();
    this.window = setInterval(() => {
      const end = performance.eventLoopUtilization();
      this.utilization = performance.eventLoopUtilization(end, this.windowStart).utilization;
      this.windowStart = end;
    }, this.windowMs);
    this.window.unref?.();
  }

  stop(): void {
    clearInterval(this.probe);
    clearInterval(this.window);
    this.probe = this.window = undefined;
    this.histogram?.disable();
  }

  /** Record a probe that ran `lateMs` after it was due. Exposed so the attribution can be tested without a stall. */
  observe(lateMs: number): LoopStall | undefined {
    if (!(lateMs >= this.thresholdMs)) return undefined;
    let activity: LoopActivity;
    try {
      activity = this.options.activity();
    } catch {
      activity = { sessions: [], operations: 0, requests: [] };
    }
    const stall: LoopStall = {
      at: new Date().toISOString(),
      durationMs: Math.round(lateMs),
      ...activity,
    };
    this.stalls.push(stall);
    if (this.stalls.length > MAX_STALLS) this.stalls.shift();
    try {
      (this.options.report ?? reportToStderr)(stall);
    } catch {
      // A closed diagnostic pipe must not turn an observation into a failure.
    }
    return stall;
  }

  snapshot(): EventLoopHealth {
    const histogram = this.histogram;
    const sampled = histogram !== undefined && histogram.count > 0;
    return {
      delay: {
        p50: sampled ? ms(histogram.percentile(50)) : 0,
        p99: sampled ? ms(histogram.percentile(99)) : 0,
        max: sampled ? ms(histogram.max) : 0,
        mean: sampled ? ms(histogram.mean) : 0,
      },
      utilization: Math.round(this.utilization * 1000) / 1000,
      thresholdMs: this.thresholdMs,
      stalls: [...this.stalls],
    };
  }
}

function reportToStderr(stall: LoopStall): void {
  process.stderr.write(
    `host event loop stalled ${stall.durationMs}ms (sessions: ${stall.sessions.join(',') || 'none'}; ` +
      `operations: ${stall.operations}; requests: ${stall.requests.join(',') || 'none'})\n`,
  );
}
