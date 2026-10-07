export { AgentHostClient } from './host-client.ts';
export type {
  ConnectedHostOptions,
  HostClientOptions,
  HostStatus,
  SpawnedHostOptions,
} from './host-client.ts';
/**
 * The seam a second carrier implements: whole lines in both directions, plus "the far side is gone".
 *
 * Exported because it is the package's reason to exist for anyone who is not this repository's desktop — a
 * carrier supplies a `HostTransport` and gets the whole protocol, rather than a copy of the client.
 */
export { lineFramer, socketTransport, stdioTransport } from './host-transport.ts';
export type { HostTransport, HostTransportExit } from './host-transport.ts';
export { SessionController } from './session-controller.ts';
export type {
  SessionSnapshot,
  PendingApproval,
  PendingQuestion,
  MessageDelta,
} from './session-controller.ts';
export { fileChangeAction, undoConfirmKey } from './change-actions.ts';
export type { FileChangeAction, FileChangeStatus } from './change-actions.ts';
