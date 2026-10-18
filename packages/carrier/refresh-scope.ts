import type { CarrierCommand, CarrierSnapshot } from './contract.ts';

/** How many audit entries the carrier keeps. */
export const AUDIT_WINDOW = 5_000;

/**
 * Which panels one command's refresh reads.
 *
 * Every command used to refresh everything — the session list, the file changes, the audit record, the task history
 * and the background panel — which is six to eight requests for a command that usually moved one panel or none. The
 * panels that change *during* a run are already event-driven (`approval.decided`, `question.answered`,
 * `run.finished`, `task.step` schedule their own refreshes), so a mid-run decision does not need the full read to be
 * correct; the transcript and the queue arrive on the controller's own channels.
 */
export interface RefreshScope {
  sessions: boolean;
  changes: boolean;
  audit: boolean;
  tasks: boolean;
  background: boolean;
}
export const FULL_REFRESH: RefreshScope = {
  sessions: true,
  changes: true,
  audit: true,
  tasks: true,
  background: true,
};
/** A decision or a queue edit during a run: only the audit record can move for this carrier to read. */
const DECISION_REFRESH: RefreshScope = {
  sessions: false,
  changes: false,
  audit: true,
  tasks: false,
  background: false,
};

/** A rename moves the sidebar row and writes one audit line; no other panel reads the title. */
const RENAME_REFRESH: RefreshScope = {
  sessions: true,
  changes: false,
  audit: true,
  tasks: false,
  background: false,
};
/** A task edit that starts nothing: the task panel and the audit line it wrote. */
const TASK_EDIT_REFRESH: RefreshScope = {
  sessions: false,
  changes: false,
  audit: true,
  tasks: true,
  background: false,
};
/** A task action that may run checks or touch files: the task panel, the files it changed and its audit line. */
const TASK_ACTION_REFRESH: RefreshScope = {
  sessions: false,
  changes: true,
  audit: true,
  tasks: true,
  background: false,
};
/** A sub-agent workspace archived, removed or restored: what the parent sees as changed, and the audit line. */
const WORKSPACE_REFRESH: RefreshScope = {
  sessions: false,
  changes: true,
  audit: true,
  tasks: false,
  background: false,
};
/** Commands that only read, or only move what the controller or the transcript already publishes. */
const NO_REFRESH: RefreshScope = {
  sessions: false,
  changes: false,
  audit: false,
  tasks: false,
  background: false,
};

/** The refresh a command's own effect requires. Unknown commands get the full read rather than a guess. */
export function refreshScopeFor(type: CarrierCommand['type']): RefreshScope {
  switch (type) {
    case 'approve':
    case 'questionAnswer':
    case 'enqueue':
    case 'clearQueue':
    case 'cancel':
    case 'sandbox':
    case 'compact':
    case 'planApprove':
    case 'planReject':
      return DECISION_REFRESH;
    case 'rename':
      return RENAME_REFRESH;
    case 'taskSave':
    case 'taskConfirm':
    case 'taskHistory':
      return TASK_EDIT_REFRESH;
    case 'taskApproval':
    case 'taskTrigger':
    case 'taskPropose':
      return TASK_ACTION_REFRESH;
    case 'subagentWorkspace':
      return WORKSPACE_REFRESH;
    case 'loadOlder':
    case 'refreshResources':
    case 'export':
    case 'subagentTranscript':
    case 'closeSubagentTranscript':
    case 'planRefresh':
      return NO_REFRESH;
    default:
      return FULL_REFRESH;
  }
}

/**
 * The audit window after one page: appended, capped to the newest entries.
 *
 * The cap matters to the cursor as much as to the panel: what is kept is the newest entries, and the seq carried
 * forward is the last kept one's, so the next read continues from the newest line however much older record the
 * window dropped.
 */
export function mergeAuditWindow(
  previous: CarrierSnapshot['audit'],
  page: CarrierSnapshot['audit'],
  limit = AUDIT_WINDOW,
): CarrierSnapshot['audit'] {
  const merged = [...previous, ...page];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
