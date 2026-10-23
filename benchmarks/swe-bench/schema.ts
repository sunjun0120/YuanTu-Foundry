export interface SweManifest {
  version: 1;
  batchId: string;
  runtime: { kind: 'commit'; revision: string };
  subset: { path: string; sha256: string };
  datasetPath: string;
  instances?: string[];
  model: string;
  protocol: 'openai' | 'openai-responses' | 'anthropic';
  endpointId: string;
  endpointUrl: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  promptCache: 'off' | 'auto';
  executionMode: 'no-commands';
  instanceTimeoutMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxObservedRequestsPerSample: number;
  maxKnownTokensPerSample: number;
  approvedLiveBudget: { authorized: boolean; maxAttempts: number };
}
function object(
  value: unknown,
  keys: string[],
  required = keys,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Missing or unknown manifest key');
}
export function validateSweManifest(input: unknown): SweManifest {
  const required = [
    'version',
    'batchId',
    'runtime',
    'subset',
    'datasetPath',
    'model',
    'protocol',
    'endpointId',
    'endpointUrl',
    'maxContextTokens',
    'maxOutputTokens',
    'promptCache',
    'executionMode',
    'instanceTimeoutMs',
    'requestTimeoutMs',
    'streamIdleTimeoutMs',
    'maxObservedRequestsPerSample',
    'maxKnownTokensPerSample',
    'approvedLiveBudget',
  ];
  object(input, [...required, 'instances'], required);
  object(input.runtime, ['kind', 'revision']);
  object(input.subset, ['path', 'sha256']);
  object(input.approvedLiveBudget, ['authorized', 'maxAttempts']);
  if (
    input.version !== 1 ||
    input.executionMode !== 'no-commands' ||
    input.runtime.kind !== 'commit' ||
    !/^[a-f0-9]{40}$/.test(String(input.runtime.revision)) ||
    !/^[a-f0-9]{64}$/.test(String(input.subset.sha256)) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(String(input.batchId))
  )
    throw new Error('Invalid manifest identity or execution mode');
  for (const value of [
    input.subset.path,
    input.datasetPath,
    input.model,
    input.endpointId,
    input.endpointUrl,
  ])
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value))
      throw new Error('Nonempty string required');
  if (
    !['openai', 'openai-responses', 'anthropic'].includes(String(input.protocol)) ||
    !['off', 'auto'].includes(String(input.promptCache))
  )
    throw new Error('Unsupported protocol or cache mode');
  const endpoint = new URL(String(input.endpointUrl));
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Endpoint must not contain credentials, query or fragment');
  for (const key of [
    'maxContextTokens',
    'maxOutputTokens',
    'instanceTimeoutMs',
    'requestTimeoutMs',
    'streamIdleTimeoutMs',
    'maxObservedRequestsPerSample',
    'maxKnownTokensPerSample',
  ])
    if (
      !Number.isSafeInteger(input[key]) ||
      (input[key] as number) <= 0 ||
      (input[key] as number) > 2_147_483_647
    )
      throw new Error(`Invalid positive limit: ${key}`);
  if (
    (input.maxOutputTokens as number) > 8192 ||
    (input.maxOutputTokens as number) >= (input.maxContextTokens as number)
  )
    throw new Error('Invalid output/context budget');
  if (
    typeof input.approvedLiveBudget.authorized !== 'boolean' ||
    !Number.isSafeInteger(input.approvedLiveBudget.maxAttempts) ||
    (input.approvedLiveBudget.maxAttempts as number) < (input.approvedLiveBudget.authorized ? 1 : 0)
  )
    throw new Error('Invalid live budget');
  if (
    input.instances !== undefined &&
    (!Array.isArray(input.instances) ||
      !input.instances.length ||
      new Set(input.instances).size !== input.instances.length ||
      input.instances.some((id) => typeof id !== 'string' || !/^[\w.-]+__[\w.-]+-\d+$/.test(id)))
  )
    throw new Error('Invalid instance selection');
  return input as unknown as SweManifest;
}
export function requireSweLiveAuthorization(input: unknown, attempts: number): SweManifest {
  const manifest = validateSweManifest(input);
  if (!manifest.approvedLiveBudget.authorized)
    throw new Error('Explicit live authorization required');
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > manifest.approvedLiveBudget.maxAttempts
  )
    throw new Error('Authorized live attempt budget exceeded');
  if (
    manifest.model.startsWith('REPLACE_') ||
    new URL(manifest.endpointUrl).hostname.endsWith('.invalid')
  )
    throw new Error('Approved real model and endpoint required');
  return manifest;
}
