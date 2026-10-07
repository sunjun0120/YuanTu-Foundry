import type { HostMethod } from '../protocol/rpc.ts';
import { HostRequestError } from '../protocol/host-wire.ts';

export interface HostPendingRequest {
  method: HostMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
type Entry = HostPendingRequest & { timer?: NodeJS.Timeout };

/** Owns request identity and deadlines, independently of process/socket supervision. */
export class HostRequests {
  private entries = new Map<string, Entry>();
  get size(): number {
    return this.entries.size;
  }
  add(id: string, request: HostPendingRequest, timeoutMs: number): void {
    if (this.entries.has(id)) throw new Error('Duplicate pending Host request ID');
    const entry: Entry = { ...request };
    this.entries.set(id, entry);
    if (timeoutMs)
      entry.timer = setTimeout(() => {
        const expired = this.take(id);
        expired?.reject(
          new HostRequestError(
            `Host request timed out: ${entry.method}; execution outcome may be unknown`,
            entry.method,
            'REQUEST_TIMEOUT',
            true,
          ),
        );
      }, timeoutMs);
  }
  take(id: string): HostPendingRequest | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
  rejectAll(error: Error): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) if (entry.timer) clearTimeout(entry.timer);
    for (const entry of entries) entry.reject(error);
  }
}
