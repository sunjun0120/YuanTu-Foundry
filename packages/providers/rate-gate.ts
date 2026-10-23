import { createHash } from 'node:crypto';
import type { ModelRequest, ModelResponse, Provider } from '../protocol/index.ts';
import { RunFailure } from '../protocol/failure.ts';

/**
 * Additive-increase / multiplicative-decrease concurrency for model requests that share one endpoint.
 *
 * A parent and up to eight sub-agents can each have a request in flight against the same endpoint, and nothing
 * slowed them down when it answered 429: every run retried on its own schedule, so the endpoint kept seeing the
 * same burst. The gate is shared by those runs. It does not limit anything until the endpoint objects: the
 * ceiling is high, and only a `rate-limit` failure halves the limit (from what was actually in flight, so a
 * single stray 429 does not throttle an idle runtime to one). Each run of `limit` successes then raises it by
 * one, back towards the ceiling. Requests over the limit wait in order, and a waiting request still honours its
 * own abort signal.
 */
export class AdaptiveConcurrency {
  private limitValue: number;
  private inFlight = 0;
  private successes = 0;
  private epoch = 0;
  private readonly waiting: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
  private readonly ceiling: number;
  private readonly floor: number;
  constructor(ceiling = 64, floor = 1) {
    this.ceiling = ceiling;
    this.floor = floor;
    this.limitValue = ceiling;
  }
  /** The current limit, for tests and diagnostics. */
  get limit(): number {
    return this.limitValue;
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    const inFlightAtStart = this.inFlight;
    const epoch = this.epoch;
    try {
      const result = await work();
      this.succeeded();
      return result;
    } catch (error) {
      if (error instanceof RunFailure && error.code === 'rate-limit')
        this.limited(inFlightAtStart, epoch);
      throw error;
    } finally {
      this.inFlight--;
      this.drain();
    }
  }
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.inFlight < this.limitValue && !this.waiting.length) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', abort);
          this.inFlight++;
          resolve();
        },
        reject,
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(entry);
    });
  }
  private drain(): void {
    while (this.waiting.length && this.inFlight < this.limitValue) this.waiting.shift()!.resolve();
  }
  private succeeded(): void {
    if (this.limitValue >= this.ceiling) return;
    this.successes++;
    if (this.successes >= this.limitValue) {
      this.successes = 0;
      this.limitValue++;
    }
  }
  /** One burst can finish many requests with 429; only its first failure starts a new recovery window. */
  private limited(inFlight: number, epoch: number): void {
    if (epoch !== this.epoch) return;
    this.epoch++;
    this.successes = 0;
    this.limitValue = Math.max(this.floor, Math.floor(Math.min(this.limitValue, inFlight) / 2));
  }
}

/**
 * The same provider, its requests passed through `gate`.
 *
 * Built on the provider as its prototype, so anything else the concrete provider exposes (and `this` inside its
 * own `complete`) is unchanged; only `complete` waits for the gate.
 */
export function gatedProvider(provider: Provider, gate: AdaptiveConcurrency): Provider {
  const gated = Object.create(provider) as Provider;
  gated.complete = (request: ModelRequest): Promise<ModelResponse> =>
    gate.run(() => provider.complete(request), request.signal);
  return gated;
}

const endpointGates = new Map<string, AdaptiveConcurrency>();
/**
 * The process's one gate for an endpoint and credential.
 *
 * The gate used to be built inside each run's `createAgent`, which made it a gate per run: two sessions talking to
 * the same endpoint each probed and backed off on their own, and the endpoint still saw their sum — the shared
 * back-off the gate exists for only held within one run and its children. Keying by protocol, base URL and a
 * fingerprint of the key gives every run of the process that hits the same quota the same gate, while a second
 * endpoint or a second account (a separate quota) keeps its own. The model is not part of the key: endpoints
 * commonly meter per key, and sharing errs towards backing off together. Never removed: a gate is a few counters,
 * and the set of endpoints a process talks to is small.
 */
export function endpointGate(endpoint: {
  protocol?: string;
  baseUrl?: string;
  apiKey: string;
}): AdaptiveConcurrency {
  const key = [
    endpoint.protocol ?? '',
    endpoint.baseUrl ?? '',
    createHash('sha256').update(endpoint.apiKey).digest('hex').slice(0, 16),
  ].join('\u0000');
  let gate = endpointGates.get(key);
  if (!gate) endpointGates.set(key, (gate = new AdaptiveConcurrency()));
  return gate;
}
