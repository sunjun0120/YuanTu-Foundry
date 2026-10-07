/** Public automation SDK. Deliberately independent of renderer/controller state. */
export { AgentHostClient, HostDisconnectedError } from '../client/host-client.ts';
export type {
  HostClientOptions,
  ConnectedHostOptions,
  SpawnedHostOptions,
  HostStatus,
} from '../client/host-client.ts';
export { lineFramer, socketTransport, stdioTransport } from '../client/host-transport.ts';
export type { HostTransport, HostTransportExit } from '../client/host-transport.ts';
export {
  HOST_PROTOCOL_VERSION,
  HOST_PROTOCOL_VERSIONS,
  HostRequestError,
  HostProtocolError,
} from '../protocol/host-wire.ts';
export type { HostInfo, HostMethod, HostMethods } from '../protocol/rpc.ts';
export type { AgentEvent, RunResult, SessionInfo, ImageAttachment } from '../protocol/index.ts';
