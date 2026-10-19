/**
 * The capability a Host advertises when `sandbox.set` acknowledges the file and network policy it was given.
 *
 * A reply's `mode` used to be the whole promise: the carrier cached `files`/`network` from the *request* when
 * the answer did not carry them, which turns "an older Host ignored this" into "the restriction is in force".
 * A Host that can say so advertises this, and only then is a strict selection (one that names files or network)
 * worth sending — let alone worth believing.
 */
export const EXECUTION_POLICY_CAPABILITY = 'execution-policy-files-network-v1';
/**
 * Commands that put the Host to work under a sandbox policy.
 *
 * Refused while the visible session's policy is unconfirmed: work handed over then would run under whatever
 * the Host happens to have, which is exactly the state a person cannot reason about. Re-selecting the sandbox
 * is deliberately not in this set, because that is how the state is left.
 */
export const EXECUTION_COMMANDS = new Set<string>([
  'send',
  'enqueue',
  'taskStart',
  'taskRetry',
  'taskVerify',
  'taskPropose',
  'goal',
  'plan',
  'planExecute',
  'approve',
  'taskApproval',
  'questionAnswer',
  'undo',
  'compact',
]);
/** One selection, as the error text names it: what a person chose versus what came back. */
export function describeSelection(selection: {
  mode: string;
  files?: string;
  network?: string;
}): string {
  return [
    `mode=${selection.mode}`,
    ...(selection.files === undefined ? [] : [`files=${selection.files}`]),
    ...(selection.network === undefined ? [] : [`network=${selection.network}`]),
  ].join(' ');
}
/**
 * Commands that change what a session holds rather than talk to a run.
 *
 * They wait for the visible run to finish and hold the service's `managing` flag while they work, so two of them
 * never interleave and none of them lands half-way through a turn.
 */
export const MANAGING_COMMANDS = new Set<string>([
  'rename',
  'deleteSession',
  'archiveSession',
  'taskRefresh',
  'taskVerify',
  'taskRetry',
  'taskHistory',
  'taskSave',
  'taskApproval',
  'taskStart',
  'taskConfirm',
  'taskPropose',
  'goal',
  'plan',
  'planApprove',
  'planReject',
  'planExecute',
  'planRefresh',
  'subagentWorkspace',
]);
