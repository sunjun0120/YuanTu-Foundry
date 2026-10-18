import type { AgentHostClient } from '../client/host-client.ts';
import type { SessionController } from '../client/session-controller.ts';
import type { CarrierSnapshot } from './contract.ts';

/**
 * The statuses a background command does not leave (`packages/tools/background.ts`). Anything else — `starting`,
 * `running`, `finishing`, or a status this carrier does not know yet — still changes, so it keeps the poll alive.
 */
const SETTLED_BACKGROUND_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'failed',
]);
/** How much of each command's output the panel keeps. */
const BACKGROUND_LOG_CHARS = 65536;
const BACKGROUND_POLL_MS = 1000;

/** What the panel needs from the carrier that owns it. */
export interface BackgroundPanelOwner {
  client: AgentHostClient;
  controller: SessionController;
  /** Whether the carrier may ask the Host anything right now. */
  ready(): boolean;
  publish(): void;
}

/**
 * The background-commands panel of the open session: the jobs, their accumulated output, and the poll that keeps
 * them current.
 *
 * The Host has no event for command output, so the panel polls — but only while something can still change
 * (`live`), and it republishes only when a read found something new. A publish deep-copies the session and
 * crosses IPC, so once a second for a panel that did not move was what an open window paid while doing nothing.
 */
export class BackgroundPanel {
  jobs: CarrierSnapshot['background'] = [];
  state: CarrierSnapshot['backgroundState'] = null;
  private cursors = new Map<string, number>();
  private logs = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private version = 0;
  /** Between `start` and `stop`: whether the panel is being kept current at all. */
  private polling = false;
  /** Set by anything that may have changed the panel since the read in flight began; see `sync`. */
  private dirty = false;
  /** What the panel last published, so a poll that read nothing new does not republish the whole snapshot. */
  private signature = '';
  private readonly owner: BackgroundPanelOwner;
  constructor(owner: BackgroundPanelOwner) {
    this.owner = owner;
  }

  async refresh(): Promise<void> {
    const { client, controller } = this.owner;
    if (this.refreshing || !this.owner.ready()) return;
    const sessionId = controller.sessionId;
    const version = ++this.version;
    if (!sessionId) {
      this.jobs = [];
      this.state = null;
      this.signature = '';
      this.sync();
      return;
    }
    this.refreshing = true;
    this.dirty = false;
    try {
      const jobs = await client.request('background.list', { sessionId });
      const state = await client.request('background.state', { sessionId });
      const next: CarrierSnapshot['background'] = [];
      for (const summary of jobs) {
        const cursor = this.cursors.get(summary.id) ?? 0;
        // `background.list` reports each job at the end of its output, so a cursor already there has nothing
        // to read: the summary is the whole answer, and a poll per job per second would only repeat it.
        if (this.logs.has(summary.id) && cursor === summary.nextCursor) {
          next.push({ ...summary, output: this.logs.get(summary.id)!, nextCursor: cursor });
          continue;
        }
        try {
          const current = await client.request('background.poll', {
            sessionId,
            id: summary.id,
            cursor,
            waitMs: 0,
          });
          const previous = this.logs.get(summary.id) ?? '';
          const combined = current.truncated ? current.output : previous + current.output;
          this.logs.set(summary.id, combined.slice(-BACKGROUND_LOG_CHARS));
          this.cursors.set(summary.id, current.nextCursor);
          next.push({ ...current, output: this.logs.get(summary.id)! });
        } catch {
          next.push({
            ...summary,
            output: this.logs.get(summary.id) ?? summary.output,
            nextCursor: this.cursors.get(summary.id) ?? summary.nextCursor,
          });
        }
      }
      if (version !== this.version || sessionId !== controller.sessionId) return;
      this.jobs = next;
      this.state = state;
      const ids = new Set(next.map((job) => job.id));
      for (const id of this.cursors.keys()) if (!ids.has(id)) this.cursors.delete(id);
      const signature = JSON.stringify([next, state]);
      if (signature === this.signature) return;
      this.signature = signature;
      this.owner.publish();
    } finally {
      this.refreshing = false;
      this.sync();
    }
  }
  /**
   * Whether the panel can still change without anyone asking: a run is in flight (it may start a command), or a
   * command has not settled. Anything else changes only through a Host event or a command of the carrier, and
   * both re-arm the poll (`wake`, the command paths' own `refresh`).
   */
  private live(): boolean {
    const { controller } = this.owner;
    return (
      controller.running ||
      controller.loading ||
      this.jobs.some((job) => !SETTLED_BACKGROUND_STATUSES.has(job.status))
    );
  }
  private arm(): void {
    if (this.timer !== undefined) return;
    // A poll that fails because the Host went away is not an unhandled rejection: the failure is already
    // reported once, by the connection's own status channel (`subscribeStatus`), and a process that died
    // mid-poll is exactly when this fires. Letting it escape here would take down a timer callback that no
    // caller is waiting on — which is how the connected-carrier test caught it.
    this.timer = setInterval(() => void this.refresh().catch(() => {}), BACKGROUND_POLL_MS);
  }
  /**
   * Keep polling only while something is live.
   *
   * Only a finished read may stop the timer, and only when nothing marked the panel dirty while it was in flight:
   * a command started in the last moments of a run is seen by the read after `run.finished`, not lost to it.
   */
  private sync(): void {
    if (!this.polling) return;
    if (this.dirty || this.live()) {
      this.arm();
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Something happened in the open session: poll again until a read shows it is idle. */
  wake(): void {
    if (!this.polling) return;
    this.dirty = true;
    this.arm();
  }
  start(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.polling = true;
    this.arm();
    void this.refresh().catch(() => {});
  }
  /** Stop polling and forget everything read; a read still in flight is discarded when it lands. */
  stop(): void {
    this.version++;
    this.polling = false;
    this.dirty = false;
    this.signature = '';
    clearInterval(this.timer);
    this.timer = undefined;
    this.cursors.clear();
    this.logs.clear();
    this.jobs = [];
    this.state = null;
  }
}
