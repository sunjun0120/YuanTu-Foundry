/** Locale-independent failures. Application shells own their translated copy. */
const messages = {
  hostExited: 'Agent Host exited unexpectedly; restart the application.',
  hostDisconnected:
    'The Agent Host connection was lost; ask the carrier that started it to reconnect.',
  policyUnsupported:
    'Agent Host does not acknowledge file/network execution policy (missing execution-policy-files-network-v1); upgrade Agent Host and select the preset again.',
  policyMismatch:
    'Agent Host did not confirm the requested execution policy (requested {requested}, received {received}); policy status is unknown and execution is blocked until it is confirmed again.',
  hostRecoveryFailed:
    'Agent Host exited unexpectedly and automatic restart failed; restart the application.',
  hostRecovering: 'Agent Host is restarting automatically; please wait.',
  hostNotReady: 'Agent Host is not ready; restart the desktop',
  workspaceMaintenanceUnsupported:
    'This Agent Host does not support orphan workspace maintenance; upgrade the Host.',
  policyUnconfirmed:
    'Execution policy is unconfirmed: Agent Host did not acknowledge the last sandbox selection. Select and confirm a preset before running again.',
  modelNotConfigured: 'Open Model settings and enter an endpoint, model ID and API key.',
  draftPlanningFailed:
    'The draft was saved, but automatic planning did not finish; edit it before execution. {message}',
  sessionRequired: 'Create or load a session first',
  subagentNotInSession: 'That sub-agent does not belong to this session',
  sessionOperationBusy: 'Session operation is in progress',
  runBusy: 'Wait for the current run or loading operation to finish',
  operationBusy: 'Wait for the current operation to finish',
  taskNotFound: 'Task not found',
  shellCommand: 'This command belongs to the carrier shell, not the carrier service',
} as const;

export type CarrierErrorCode = keyof typeof messages;
export interface CarrierIssue {
  code: CarrierErrorCode;
  values: Record<string, string | number>;
}

/** The English message remains usable by a caller without a locale or dictionary. */
export class CarrierError extends Error {
  readonly code: CarrierErrorCode;
  readonly values: CarrierIssue['values'];

  constructor(code: CarrierErrorCode, values: CarrierIssue['values'] = {}) {
    super(
      messages[code].replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : match,
      ),
    );
    this.name = 'CarrierError';
    this.code = code;
    this.values = { ...values };
  }
}

/** Plain data for IPC/JSON, with the same redaction applied to parameters as to the fallback message. */
export function carrierIssue(
  error: unknown,
  redact: (value: string) => string,
): CarrierIssue | null {
  if (!(error instanceof CarrierError)) return null;
  return {
    code: error.code,
    values: Object.fromEntries(
      Object.entries(error.values).map(([key, value]) => [
        key,
        typeof value === 'string' ? redact(value) : value,
      ]),
    ),
  };
}
