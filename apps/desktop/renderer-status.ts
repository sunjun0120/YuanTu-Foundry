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
  /** Whether the Host connection is usable. */
  ready: boolean;
  loading: boolean;
  activity?: { kind: 'model' | 'tool'; phase?: 'reasoning' | 'tool_call' | 'text' } | null;
  tools?: number;
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
export function runStatusText(input: RunStatusInput): string {
  if (input.compacting) return t('ui.runStatus.compacting');
  if (input.approvals) return t('ui.runStatus.awaitingApproval');
  if (!input.ready) return t('ui.runStatus.connecting');
  if (input.loading) return t('ui.runStatus.loadingSession');
  if (input.status === 'running') {
    if (input.tools || input.activity?.kind === 'tool') return t('ui.runStatus.tools');
    if (input.activity?.kind === 'model') {
      if (input.activity.phase === 'reasoning') return t('ui.modelReasoning');
      if (input.activity.phase === 'tool_call') return t('ui.modelToolCall');
      if (input.activity.phase === 'text') return t('ui.runStatus.responding');
      return t('ui.runStatus.waitingModel');
    }
    return t('ui.runStatus.preparing');
  }
  return t(KEYS[input.status]);
}
