/**
 * What the page and the bridge say to each other.
 *
 * One vocabulary, not a second one: a command is a `CarrierCommand` (the same type the desktop's IPC channel
 * carries and the same one `parseCarrierCommand` validates), a state is a `CarrierSnapshot`, and a delta is one
 * of the three delta shapes. The bridge is a transport — it decides nothing about what a command means, which is
 * why adding a carrier does not add a protocol.
 *
 * The envelope is deliberately thin: an `id` so a reply can be matched to its request, and a `kind` so the
 * bridge can refuse what it does not serve instead of guessing.
 */
import type {
  CarrierCommand,
  CarrierSnapshot,
  MessageDelta,
  StatisticsDelta,
  SubAgentDelta,
} from '../../packages/carrier/contract.ts';
import type { FilesCommand } from '../desktop/files-contract.ts';

/** Requests the page may send. Anything else is refused with a reason. */
export type BridgeRequest =
  | { readonly kind: 'command'; readonly id: number; readonly command: CarrierCommand }
  | { readonly kind: 'files'; readonly id: number; readonly command: FilesCommand };

/** Frames the bridge may send. */
export type BridgeFrame =
  | { readonly kind: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'reply'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: 'state'; readonly state: CarrierSnapshot }
  | { readonly kind: 'delta'; readonly delta: MessageDelta }
  | { readonly kind: 'subagent-delta'; readonly delta: SubAgentDelta }
  | { readonly kind: 'statistics-delta'; readonly delta: StatisticsDelta }
  /** The link is not going to be served, and this is why. Sent before the close frame. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Read one request off the wire, or say what is wrong with it.
 *
 * The command itself is *not* validated here: `CarrierService.dispatch` runs every command through
 * `parseCarrierCommand`, and a second validator would be a second answer to "is this command legal".
 */
export function parseBridgeRequest(value: unknown): BridgeRequest | { readonly error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { error: 'a bridge request must be an object' };
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.id) || (record.id as number) < 1)
    return { error: 'a bridge request needs a positive integer id' };
  if (record.kind === 'command')
    return { kind: 'command', id: record.id as number, command: record.command as CarrierCommand };
  if (record.kind === 'files')
    return { kind: 'files', id: record.id as number, command: record.command as FilesCommand };
  return { error: `unknown bridge request kind: ${String(record.kind)}` };
}
