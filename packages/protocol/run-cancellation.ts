export type CancelReason = 'user' | 'shutdown' | 'background-budget' | 'background-policy';

/** Typed abort evidence. Unknown AbortSignal reasons remain unclassified. */
export class RunCancellation extends Error {
  readonly cancelReason: CancelReason;
  constructor(cancelReason: CancelReason) {
    super(`Run cancelled: ${cancelReason}`);
    this.name = 'RunCancellation';
    this.cancelReason = cancelReason;
  }
}

/** Display evidence only; never a message or provider input. */
export interface RunEnding {
  runId: string;
  afterIndex: number;
  status: 'cancelled' | 'failed' | 'limited' | 'interrupted';
  cancelReason?: CancelReason;
  error?: string;
}
