import { HostProtocolError } from '../../packages/protocol/host-wire.ts';
import { MAX_INPUT_BYTES } from '../../packages/protocol/images.ts';
import { safeError } from '../shared/runtime.ts';
import { backgroundHandlers } from './handlers/background.ts';
import { compactionHandlers } from './handlers/compaction.ts';
import { fileHandlers } from './handlers/files.ts';
import { historyHandlers } from './handlers/history.ts';
import { interactionHandlers } from './handlers/interaction.ts';
import { runHandlers } from './handlers/runs.ts';
import { sessionHandlers } from './handlers/sessions.ts';
import { systemHandlers } from './handlers/system.ts';
import { taskHandlers } from './handlers/tasks.ts';
import type { Dispatcher, HostContext, WakeGrant } from './state.ts';

/**
 * One method of the Host protocol.
 *
 * `wake` is passed only to `run.start`: it is the one method whose meaning changes when the Host starts it
 * itself, and giving every handler a parameter only one of them reads would be a seam nobody could trace.
 */
export type Handler = (
  ctx: HostContext,
  params: Record<string, unknown>,
  wake?: WakeGrant,
) => Promise<unknown>;

/**
 * Every method the Host answers, grouped by the domain that owns it.
 *
 * The table is a `Map` rather than an object, and that is not a style choice: a method name arrives from the
 * wire, and an object lookup would answer `constructor` and `toString` with something inherited from
 * `Object.prototype` instead of the `Unknown method` refusal the protocol promises.
 *
 * Adding a case here is what makes a method reachable, and the name is the contract — the docs gate counts the
 * methods from `packages/protocol/rpc.ts`, and a client gates on the capability string `host.info` reports.
 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  ...systemHandlers,
  ...backgroundHandlers,
  ...fileHandlers,
  ...historyHandlers,
  ...interactionHandlers,
  ...runHandlers,
  ...sessionHandlers,
  ...taskHandlers,
  ...compactionHandlers,
};

/** Build the one entry point every request goes through, closing over the Host's state. */
export function createDispatcher(ctx: HostContext): Dispatcher {
  const table = new Map(Object.entries(HANDLERS));
  return async (method: string, params: Record<string, unknown>, wake?: WakeGrant) => {
    const handler = table.get(method);
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return await handler(ctx, params, wake);
  };
}

export interface RequestHandlerOptions {
  dispatch: Dispatcher;
  send: (data: unknown) => void;
  /** Request ids being served, so a client that reuses one is refused rather than answered twice. */
  requestIds: Set<string>;
}

/**
 * Turn one line of JSONL into one frame, and never throw: a caller that has to catch is a caller that can forget
 * to answer.
 *
 * The bound is checked before the parse, because the parse is what allocates. Every failure — a malformed line, a
 * missing id, an unknown method, a handler that threw — becomes the same `{ id, error }` frame, with the code
 * carried through for the failures the protocol names and `HOST_REQUEST_FAILED` for everything else. The id slot
 * holds the request's own id when it had one and `null` when it did not, so a client can tell an answer from a
 * rejection it cannot attribute; the id is only released once the request is finished, which is what makes a
 * duplicate pending id detectable at all.
 */
export function createRequestHandler(options: RequestHandlerOptions) {
  return async function handle(line: string): Promise<void> {
    let id: string | undefined,
      registered = false;
    try {
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error('Request exceeds 16MB limit');
      const request = JSON.parse(line) as Record<string, unknown>;
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Request must be an object');
      if (typeof request.id !== 'string' || !request.id)
        throw new Error('id must be a nonempty string');
      id = request.id;
      if (options.requestIds.has(id)) throw new Error('Duplicate pending request ID');
      options.requestIds.add(id);
      registered = true;
      if (typeof request.method !== 'string') throw new Error('method must be a string');
      const params = request.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw new Error('params must be an object');
      const result = await options.dispatch(request.method, params as Record<string, unknown>);
      options.send({ id, result });
    } catch (error) {
      options.send({
        id: id ?? null,
        error: {
          message: safeError(error),
          code: error instanceof HostProtocolError ? error.code : 'HOST_REQUEST_FAILED',
        },
      });
    } finally {
      if (id && registered) options.requestIds.delete(id);
    }
  };
}
