/**
 * The carrier service: the client state machine every interface layer shares.
 *
 * A carrier is anything that shows a Host's work — today the Electron desktop, tomorrow a web page, an
 * embedded library or an editor plugin. The two exports below are its whole entry point, one per transport
 * shape:
 *
 * ```ts
 * const carrier = spawnedCarrier({ nodePath, hostPath, workspace });   // this carrier owns the Host process
 * const carrier = connectedCarrier({ transport: socketTransport(socket) }); // somebody else's Host, this link
 * await carrier.start();
 * await carrier.dispatch({ type: 'send', prompt: 'hello' });
 * ```
 *
 * The service itself has no DOM, no Electron and no window API; a test reads these sources and fails if one
 * appears. The interface layer — slots, components, the shell — is a separate, later step.
 */
import type { ConnectedHostOptions, SpawnedHostOptions } from '../client/host-client.ts';
import { CarrierService } from './service.ts';

export { CarrierService } from './service.ts';
export { parseCarrierCommand } from './contract.ts';
export type { CarrierCommand, CarrierSnapshot, SubAgentTranscript } from './contract.ts';
export type { MessageDelta, SubAgentDelta, StatisticsDelta } from './contract.ts';

/**
 * A carrier that owns its Host process.
 *
 * It spawns the Host, supervises it, and is the one that can bring it back after a crash — which is why the
 * failure report names a pid.
 */
export function spawnedCarrier(options: SpawnedHostOptions): CarrierService {
  return new CarrierService(options);
}

/**
 * A carrier that was handed a link to a Host somebody else started.
 *
 * There is no process to restart and no pid to name: the client reports the link as failed and reconnecting is
 * the carrier's own business. Everything above the transport — framing, requests, the whole state machine —
 * is the same code, which is the point of the split.
 */
export function connectedCarrier(options: ConnectedHostOptions): CarrierService {
  return new CarrierService(options);
}
