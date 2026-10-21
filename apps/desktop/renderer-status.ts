import { t } from './i18n.ts';
import type { RunStatus } from '../../packages/protocol/index.ts';

/**
 * What the run status line says, and which of its states wins when more than one is true.
 *
 * The line is a single element with several possible things to say, so the *order* of the checks below is the
 * rule, not an implementation detail: a compaction in flight outranks everything (nothing else the line could
 * say is more useful while the context is being rewritten), an approval outranks a connection that is not ready
 * (the run is waiting on the person, not on the network), and a not-ready connection outranks a session that is
 * still loading.
 *
 * Keeping the vocabulary here rather than inline in `renderer.ts` is what makes it checkable: every branch is a
 * dictionary key, and `tests/desktop-copy.test.ts` fails if a key is missing in English or still resolves to its
 * own name. That is the state this replaced — literals that only the DOM walker could translate, four of which
 * were absent from the dictionary, so an English interface showed Chinese for exactly those four.
 */
export type SessionRunStatus = 'idle' | 'running' | RunStatus;
export interface RunStatusInput {
  status: SessionRunStatus;
  compacting: boolean;
  /** How many approvals are waiting; the line says so while any is. */
  approvals: number;
  /** How many questions are waiting. A run that waits on a person is not "running a tool". */
  questions?: number;
  /** Whether the Host connection is usable. */
  ready: boolean;
  loading: boolean;
  activity?: {
    kind: 'model' | 'tool';
    phase?: 'reasoning' | 'tool_call' | 'text';
    startedAt?: number;
  } | null;
  /** The clock the wait is measured against; the caller re-renders while a model is silent. */
  now?: number;
  tools?: number;
  /** Why the last verdict stopped, so a check the environment could not run is not called a failed one. */
  completionReason?: string;
}
/** `idle` reuses `ui.ready` so one Chinese source cannot acquire two English wordings. */
const KEYS: Record<SessionRunStatus, string> = {
  idle: 'ui.ready',
  running: 'ui.runStatus.running',
  completed: 'ui.runStatus.completed',
  needs_review: 'ui.runStatus.needsReview',
  cancelled: 'ui.runStatus.cancelled',
  limited: 'ui.runStatus.limited',
  failed: 'ui.runStatus.failed',
};
/** How long a silent model is "waiting" before the line starts counting. */
export const SLOW_MODEL_MS = 15_000;
export function runStatusText(input: RunStatusInput): string {
  if (input.compacting) return t('ui.runStatus.compacting');
  if (input.approvals) return t('ui.runStatus.awaitingApproval');
  // A question is also the run waiting on the person, and it used to read 正在执行工具…: the tool that asked is
  // still open, and the status line described work that had stopped.
  if (input.questions) return t('ui.runStatus.awaitingAnswer');
  if (!input.ready) return t('ui.runStatus.connecting');
  if (input.loading) return t('ui.runStatus.loadingSession');
  if (input.status === 'running') {
    if (input.tools || input.activity?.kind === 'tool') return t('ui.runStatus.tools');
    if (input.activity?.kind === 'model') {
      if (input.activity.phase === 'reasoning') return t('ui.modelReasoning');
      if (input.activity.phase === 'tool_call') return t('ui.modelToolCall');
      if (input.activity.phase === 'text') return t('ui.runStatus.responding');
      // A slow endpoint (a 30 s first token was measured) left "正在等待模型响应…" unchanged for half a minute,
      // which reads as a hang. After the threshold the line counts the wait so the person can tell it is alive.
      const waited =
        input.now !== undefined && input.activity.startedAt !== undefined
          ? input.now - input.activity.startedAt
          : 0;
      if (waited >= SLOW_MODEL_MS)
        return t('ui.runStatus.waitingModelLong', { seconds: String(Math.floor(waited / 1_000)) });
      return t('ui.runStatus.waitingModel');
    }
    return t('ui.runStatus.preparing');
  }
  // `environment-error` stops the verdict at needs_review too, but nothing about the work failed: the check could
  // not run here. Saying 验收未通过 for it told the person their task had failed when the code was fine.
  if (
    input.status === 'needs_review' &&
    input.completionReason?.split(':')[0]?.trim() === 'environment-error'
  )
    return t('ui.runStatus.environmentLimited');
  return t(KEYS[input.status]);
}

/** The kernel's marker for "the signal aborted this run", which is what pressing 停止 produces. */
export const RUN_CANCELLED = 'Run cancelled';
/** What the completion verdict looked like when the run ended, as far as the banner decision needs it. */
export interface RunErrorInput {
  /** The text the banner was asked to show (a local error, a carrier error, or the run's own). */
  error: string | null | undefined;
  /** The error recorded on the session: equal to `error` when the run itself produced it. */
  sessionError?: string | null;
  /** The completion verdict, when the run has one. */
  completion?: { state: string; reason: string } | null;
}
/**
 * Which error text becomes the red banner across the top of the conversation.
 *
 * Two run outcomes are statuses rather than failures, and neither deserves the banner:
 *
 * - A cancelled run: the person pressed 停止, and drawing it as a failure in English across a Chinese interface
 *   was wrong twice over. The conversation already ends with the paused line.
 * - `needs_review`: a verdict, not a failure. The completion block under the transcript states it in the user's
 *   language (验收未通过，需检查), and the kernel's English reason string was leaking into the banner beside it —
 *   the code used to suppress only `missing-verification`, which is one of several review reasons.
 *
 * Only the run's own error is suppressed: a local or carrier error stays visible even next to a review, because
 * it is about the window, not about the work.
 */
export function visibleRunError(input: RunErrorInput): string {
  if (!input.error) return '';
  if (input.error === RUN_CANCELLED) return '';
  const isRunError = input.sessionError != null && input.error === input.sessionError;
  if (isRunError && input.completion?.state === 'needs_review') return '';
  return input.error;
}
