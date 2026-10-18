import { readDisplayHistory } from '../client/display-history.ts';
import type { AgentHostClient } from '../client/host-client.ts';
import type { SessionController } from '../client/session-controller.ts';
import type { SubAgentTranscript } from './contract.ts';
import { CarrierError } from './errors.ts';

/** Keep the newest process records and the final reply within a bounded child history window. */
const SUBAGENT_TRANSCRIPT_MESSAGES = 200;
const SUBAGENT_TRANSCRIPT_POLL_MS = 700;
const SUBAGENT_TRANSCRIPT_POLL_MAX_MS = 5_000;

/** What the viewer needs from the carrier that owns it. */
export interface SubAgentTranscriptOwner {
  client: AgentHostClient;
  controller: SessionController;
  publish(): void;
}

/**
 * The sub-agent transcript the user opened, if any: read-only, scoped to the open session, and kept current by a
 * poll that backs off while the child is quiet.
 */
export class SubAgentTranscriptViewer {
  current: SubAgentTranscript | null = null;
  private offset = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = SUBAGENT_TRANSCRIPT_POLL_MS;
  private refreshing = false;
  private version = 0;
  private readonly owner: SubAgentTranscriptOwner;
  constructor(owner: SubAgentTranscriptOwner) {
    this.owner = owner;
  }
  /**
   * Opens a sub-agent's transcript for reading.
   *
   * The ids come from the interface, so they are checked against the delegations this session actually
   * recorded — the viewer must not become a way to read any session in the workspace. The bounded
   * window starts at the tail so a long process cannot hide the child's final reply at the end.
   */
  async open(subagentId: string, childSessionId: string): Promise<void> {
    this.close();
    const version = this.version;
    const sessionId = this.owner.controller.sessionId;
    if (!sessionId) throw new CarrierError('sessionRequired');
    // The durable card list shows completed delegations. While the current run is still active, its child
    // exists only in the controller's live event projection, so the viewer must accept that same trusted view.
    const live = this.owner.controller.findSubAgent(
      (entry) => entry.id === subagentId && entry.childSessionId === childSessionId,
    );
    const summary =
      live ??
      (
        await this.owner.client.request('subagents.list', { sessionId, includePreviousRuns: true })
      ).find((entry) => entry.id === subagentId && entry.sessionId === childSessionId);
    if (!summary) throw new CarrierError('subagentNotInSession');
    const history = await readDisplayHistory(
      this.owner.client,
      childSessionId,
      SUBAGENT_TRANSCRIPT_MESSAGES,
      0,
      { tail: SUBAGENT_TRANSCRIPT_MESSAGES },
    );
    if (version !== this.version) return;
    this.current = {
      subagentId,
      childSessionId,
      objective: summary.objective,
      status: summary.status,
      ...(summary.report ? { report: summary.report } : {}),
      ...(summary.error ? { error: summary.error } : {}),
      messages: history.messages,
      truncated: history.truncated || history.startOffset > 0,
    };
    this.offset = history.nextOffset;
    this.startPolling();
  }
  /**
   * Poll the open transcript, backing off while it is quiet.
   *
   * A child that is streaming is read every 700 ms; each read that finds nothing doubles the wait, up to five
   * seconds, so a finished or idle child left open on screen stops costing a history read per second. Any read
   * that finds something, and any streamed text from that child, brings the pace back.
   */
  private startPolling(): void {
    this.stopPolling();
    this.delay = SUBAGENT_TRANSCRIPT_POLL_MS;
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    const version = this.version;
    this.timer = setTimeout(() => {
      void this.refresh()
        .catch(() => false)
        .then((changed) => {
          if (version !== this.version || !this.current) return;
          this.delay = changed
            ? SUBAGENT_TRANSCRIPT_POLL_MS
            : Math.min(this.delay * 2, SUBAGENT_TRANSCRIPT_POLL_MAX_MS);
          this.schedule();
        });
    }, this.delay);
  }
  /** The open child is producing output: read it at full pace again. */
  quicken(subagentId: string): void {
    if (this.current?.subagentId !== subagentId) return;
    if (this.delay === SUBAGENT_TRANSCRIPT_POLL_MS) return;
    this.delay = SUBAGENT_TRANSCRIPT_POLL_MS;
    this.schedule();
  }
  private stopPolling(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  close(): void {
    this.version++;
    this.current = null;
    this.stopPolling();
  }
  /** One read of the open transcript; whether it changed what the panel shows. */
  private async refresh(): Promise<boolean> {
    const transcript = this.current;
    if (!transcript || this.refreshing || this.owner.client.status !== 'ready') return false;
    this.refreshing = true;
    try {
      let history = await readDisplayHistory(
        this.owner.client,
        transcript.childSessionId,
        100,
        this.offset,
      );
      // If a busy child produced more than a polling page, catch up to its newest window rather
      // than working through old process records while its completed answer stays off screen.
      const replaceWindow = history.truncated;
      if (replaceWindow)
        history = await readDisplayHistory(
          this.owner.client,
          transcript.childSessionId,
          SUBAGENT_TRANSCRIPT_MESSAGES,
          0,
          { tail: SUBAGENT_TRANSCRIPT_MESSAGES },
        );
      if (this.current !== transcript) return false;
      this.offset = history.nextOffset;
      const current = this.owner.controller.findSubAgent(
        (entry) =>
          entry.id === transcript.subagentId && entry.childSessionId === transcript.childSessionId,
      );
      const previousResult = JSON.stringify([
        transcript.status,
        transcript.report,
        transcript.error,
      ]);
      if (current) {
        transcript.status = current.status;
        transcript.report = current.report;
        transcript.error = current.error;
      }
      if (!history.messages.length) {
        const moved =
          previousResult !==
          JSON.stringify([transcript.status, transcript.report, transcript.error]);
        if (moved) this.owner.publish();
        return moved;
      }
      const combined = replaceWindow
        ? history.messages
        : [...transcript.messages, ...history.messages];
      transcript.messages = combined.slice(-SUBAGENT_TRANSCRIPT_MESSAGES);
      transcript.truncated ||=
        history.truncated ||
        (replaceWindow && history.startOffset > 0) ||
        combined.length > SUBAGENT_TRANSCRIPT_MESSAGES;
      this.owner.publish();
      return true;
    } finally {
      this.refreshing = false;
    }
  }
}
