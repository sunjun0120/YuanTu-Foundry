import type { ModelResponse } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { StepEndReason } from '../../protocol/steps.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { RunEmit } from './emit.ts';

export interface RunStepsOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  statistics: SessionStatistics;
  emit: RunEmit;
}

/**
 * The step the log has open, its timing, and the one way it closes. Every exit from the round loop
 * goes through `end`, so each `step.started` gets exactly one `step.finished`; an open step means a
 * crash.
 */
export class RunSteps {
  private readonly options: RunStepsOptions;
  /** The step the log has open, or `null` between steps. */
  open: number | null = null;
  /**
   * When the open step began and when its first visible text arrived, measured per step (retries
   * included). `null` outside a step so nothing is accrued twice.
   */
  private startedAt: number | null = null;
  private firstTokenAt: number | null = null;

  constructor(options: RunStepsOptions) {
    this.options = options;
  }

  /**
   * Open a step before the round does anything, so a step that dies while building its request is
   * still named.
   */
  begin(step: number): void {
    const { store, sessionId, runId } = this.options;
    store.recordEvent(sessionId, 'step.started', { runId, step });
    this.open = step;
    this.startedAt = performance.now();
    this.firstTokenAt = null;
  }

  /** Visible text arrived; the first delta of a step is its first-token latency. */
  visibleText(delta: string): void {
    if (this.firstTokenAt === null && delta.length && this.startedAt !== null) {
      const { statistics } = this.options;
      this.firstTokenAt = performance.now();
      statistics.firstTokenMs += Math.max(0, this.firstTokenAt - this.startedAt);
      statistics.firstTokenCount += 1;
    }
  }

  /**
   * Close the open step's spans when its answer is assembled. Only a reported output count makes it
   * a decode sample.
   */
  commitTiming(response: ModelResponse): void {
    if (this.startedAt === null) return;
    const { statistics } = this.options;
    const now = performance.now();
    statistics.modelMs += Math.max(0, now - this.startedAt);
    if (this.firstTokenAt !== null && response.usage.outputTokens > 0) {
      statistics.decodeMs += Math.max(0, now - this.firstTokenAt);
      const reasoningTokens = response.outputDiagnostics?.reasoningTokens;
      const known =
        reasoningTokens !== undefined &&
        Number.isInteger(reasoningTokens) &&
        reasoningTokens >= 0 &&
        reasoningTokens <= response.usage.outputTokens &&
        response.toolCalls.length === 0 &&
        !response.outputDiagnostics?.toolArgumentChars;
      statistics.decodeKnown = statistics.decodeKnown !== false && known;
      if (known) statistics.decodeTokens += response.usage.outputTokens - reasoningTokens;
    }
    this.startedAt = null;
    this.firstTokenAt = null;
  }

  end(step: number, reason: StepEndReason): void {
    const { store, sessionId, runId, statistics, emit } = this.options;
    this.open = null;
    // Whatever a step opened and never committed — a cancellation, a failure mid-stream — leaves no span
    // behind. The boundary is still counted, because it happened, and the run that closed it is a turn.
    this.startedAt = null;
    this.firstTokenAt = null;
    statistics.steps += 1;
    statistics.turns = 1;
    store.recordEvent(sessionId, 'step.finished', { runId, step, reason });
    // A step boundary is a stopping point, so a long run checkpoints here too rather than only at its end:
    // a crash hours into it then reopens from a recent fold instead of the whole log.
    store.checkpointIfDue(sessionId);
    // The panel's counts and wall times change exactly here, so the boundary is what a listener is told
    // about; a client that only saw the live channel would otherwise learn the step count a round late.
    emit('statistics.updated', { statistics: { ...statistics }, activity: null });
  }
}
