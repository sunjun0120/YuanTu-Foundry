export function acquireResourceLease(
  directory: string,
  resources: string[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<() => void>;
