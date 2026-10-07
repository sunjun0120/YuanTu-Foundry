import path from 'node:path';
import type { HostInfo } from './rpc.ts';

export const HOST_PROTOCOL_VERSION = 1 as const;
export const HOST_PROTOCOL_VERSIONS = [HOST_PROTOCOL_VERSION] as const;
export const HOST_LONG_REQUESTS = new Set([
  'run.start',
  'task.propose',
  'task.retry',
  'task.verify',
  'task.confirm',
  'context.compact',
]);

export class HostProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HostProtocolError';
    this.code = code;
  }
}

/** Old clients omit the offer. New clients must explicitly offer a common version. */
export function negotiateHostVersion(params: Record<string, unknown>): 1 {
  const versions = params.protocolVersions;
  if (versions === undefined) return HOST_PROTOCOL_VERSION;
  if (
    !Array.isArray(versions) ||
    !versions.length ||
    versions.length > 16 ||
    versions.some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new HostProtocolError('Invalid protocolVersions offer', 'INVALID_PARAMS');
  if (!versions.includes(HOST_PROTOCOL_VERSION))
    throw new HostProtocolError(
      'No compatible Agent Host protocol version',
      'UNSUPPORTED_PROTOCOL',
    );
  return HOST_PROTOCOL_VERSION;
}

/** Additive metadata is allowed; incompatible mandatory fields are never coerced. */
export function validateHostInfo(value: unknown): HostInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HostProtocolError('Incompatible Agent Host protocol', 'UNSUPPORTED_PROTOCOL');
  const info = value as Record<string, unknown>;
  if (
    info.protocolVersion !== HOST_PROTOCOL_VERSION ||
    info.runtime !== 'yuantu' ||
    typeof info.workspace !== 'string' ||
    !path.isAbsolute(info.workspace) ||
    !Array.isArray(info.capabilities) ||
    info.capabilities.some((item) => typeof item !== 'string')
  )
    throw new HostProtocolError('Incompatible Agent Host protocol', 'UNSUPPORTED_PROTOCOL');
  return value as HostInfo;
}

export class HostRequestError extends Error {
  readonly method: string;
  readonly code: string;
  readonly outcomeUnknown: boolean;
  constructor(
    message: string,
    method: string,
    code = 'HOST_REQUEST_FAILED',
    outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'HostRequestError';
    this.method = method;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
