import type {
  PreparedRequestFingerprint,
  RequestFingerprint,
} from '../../protocol/request-cache.ts';

/** Refuse incomplete legacy or damaged fingerprints instead of inventing a comparison baseline. */
export function readRequestFingerprint(value: unknown): RequestFingerprint | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (
    !['routeHash', 'systemHash', 'toolsHash', 'configurationHash', 'historyHash'].every(
      (key) => typeof data[key] === 'string' && /^[a-f0-9]{64}$/.test(data[key] as string),
    )
  )
    return;
  if (!Number.isSafeInteger(data.messageCount) || (data.messageCount as number) < 0) return;
  return data as unknown as RequestFingerprint;
}

/** Observed prefix differences are diagnostic hints; only provider usage establishes actual cache reuse. */
export function compareRequestFingerprint(
  current: PreparedRequestFingerprint,
  previous?: RequestFingerprint,
): {
  fingerprint: RequestFingerprint;
  prefixChanges: string[];
  historyChange: 'initial' | 'unchanged' | 'append' | 'rewritten';
} {
  const { historyPrefixes: _prefixes, ...fingerprint } = current;
  if (!previous) return { fingerprint, prefixChanges: ['initial'], historyChange: 'initial' };
  const prefixChanges: string[] = [];
  for (const [field, reason] of [
    ['routeHash', 'route'],
    ['systemHash', 'system'],
    ['toolsHash', 'tools'],
    ['configurationHash', 'configuration'],
  ] as const)
    if (previous[field] !== current[field]) prefixChanges.push(reason);
  const historyChange =
    previous.historyHash === current.historyHash
      ? 'unchanged'
      : current.historyPrefixes[previous.messageCount] === previous.historyHash
        ? 'append'
        : 'rewritten';
  if (historyChange === 'rewritten') prefixChanges.push('history');
  return { fingerprint, prefixChanges, historyChange };
}
