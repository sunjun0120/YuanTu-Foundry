import type { FileChange } from './index.ts';

export interface StoredFileChange {
  id: string;
  sessionId: string;
  runId?: string;
  /** True when a terminal event exists, even if an old migration lost its transcript position. */
  runFinished?: boolean;
  /** Absolute transcript position after which this finished run's changes are displayed. */
  endMessageIndex?: number;
  change: FileChange;
  status: 'pending' | 'applied' | 'abandoned' | 'conflict' | 'undoing' | 'undone';
  createdAt: string;
}
