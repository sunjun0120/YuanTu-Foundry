import type { FileChange, FileSnapshot } from '../protocol/index.ts';
import type { WorkspaceApplyReceipt } from '../protocol/workspaces.ts';
import { WorkspaceFailure } from '../protocol/workspaces.ts';
import type { StoredFileChange } from './session-schema.ts';
import type { SessionWorkspaces } from './session-workspaces.ts';

export interface SessionWorkspaceApplyPort {
  transaction<T>(fn: () => T): T;
  workspaces: Pick<
    SessionWorkspaces,
    'receipt' | 'setResultStatus' | 'recordReceipt' | 'removeReceipt'
  >;
  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string;
  markFileChange(id: string, status: StoredFileChange['status']): void;
}

/**
 * Importing a child's workspace result into the parent: the three transitions that must move a result's status,
 * its recovery receipt and the file-change journal together. Each one is a single transaction because a crash
 * between the halves would leave a result that says one thing and a journal that says another.
 */
export class SessionWorkspaceApply {
  private readonly port: SessionWorkspaceApplyPort;

  constructor(port: SessionWorkspaceApplyPort) {
    this.port = port;
  }

  /** Publish an import attempt and its recovery journal atomically, before any file writes. */
  begin(input: {
    parentSessionId: string;
    resultId: string;
    digest: string;
    targetBindingId: string;
    change: FileChange;
    files: FileSnapshot[];
  }): string {
    return this.port.transaction(() => {
      if (this.port.workspaces.receipt(input))
        throw new WorkspaceFailure('WORKSPACE_BUSY', 'This import already has a recovery record');
      this.port.workspaces.setResultStatus({
        resultId: input.resultId,
        expect: ['ready', 'conflict'],
        to: 'applying',
      });
      const changeId = this.port.prepareFileChangeGroup(
        input.parentSessionId,
        input.change,
        input.files,
      );
      this.port.workspaces.recordReceipt({ ...input, changeId });
      return changeId;
    });
  }

  /** The durable success state and the journal must commit together. */
  finish(resultId: string, changeId: string): void {
    this.port.transaction(() => {
      this.port.markFileChange(changeId, 'applied');
      this.port.workspaces.setResultStatus({ resultId, expect: 'applying', to: 'applied' });
    });
  }

  /** Recovery proved every path still has its before bytes; abandon this attempt and allow new approval. */
  resetUnwritten(receipt: WorkspaceApplyReceipt): void {
    this.port.transaction(() => {
      this.port.markFileChange(receipt.changeId, 'abandoned');
      this.port.workspaces.removeReceipt(receipt.id, receipt.changeId);
      this.port.workspaces.setResultStatus({
        resultId: receipt.resultId,
        expect: 'applying',
        to: 'ready',
      });
    });
  }
}
