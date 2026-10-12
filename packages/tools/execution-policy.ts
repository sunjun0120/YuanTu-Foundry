import { AsyncLocalStorage } from 'node:async_hooks';
import { declaredExecutionCapabilities } from './execution-capabilities.ts';
import type {
  ExecutionPolicy,
  ExecutionMode,
  ExecutionCapabilities,
  FileEffect,
  NetworkEffect,
} from '../protocol/execution.ts';
import { parseSandboxMode } from './sandbox-mode.ts';

const calls = new AsyncLocalStorage<ExecutionPolicy>();
export function executionPolicy(
  mode: ExecutionMode,
  options: {
    files?: FileEffect;
    image?: string;
    network?: NetworkEffect;
    requestedNetwork?: NetworkEffect;
  } = {},
): ExecutionPolicy {
  parseSandboxMode(mode);
  const image = options.image ?? 'native';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
    throw new Error('Invalid sandbox image');
  if (
    options.files !== undefined &&
    options.files !== 'read-only' &&
    options.files !== 'workspace-write'
  )
    throw new Error('Invalid file policy');
  const network = options.requestedNetwork ?? options.network;
  if (network !== undefined && network !== 'denied' && network !== 'unrestricted')
    throw new Error('Invalid network policy');
  const supported = declaredExecutionCapabilities({
    mode,
    image,
    files: options.files ?? 'workspace-write',
    network,
  });
  if (network && supported.network !== network)
    throw new Error('Backend network capability does not satisfy this policy');
  return Object.freeze({
    mode,
    image,
    files: options.files ?? 'workspace-write',
    processFiles: supported.processFiles,
    network: supported.network,
    ...(network ? { requestedNetwork: network } : {}),
  });
}
export function requireExecutionCapabilities(
  policy: ExecutionPolicy,
  required: Partial<Pick<ExecutionCapabilities, 'processFiles' | 'network'>>,
): void {
  const actual = declaredExecutionCapabilities({
    mode: policy.mode,
    image: policy.image,
    files: policy.files,
    network: policy.requestedNetwork,
  });
  if (!actual || policy.processFiles !== actual.processFiles || policy.network !== actual.network)
    throw new Error('Execution backend cannot enforce the declared policy');
  if (required.processFiles && required.processFiles !== actual.processFiles)
    throw new Error('Backend filesystem capability does not satisfy this call');
  if (required.network && required.network !== actual.network)
    throw new Error('Backend network capability does not satisfy this call');
}
export function snapshotExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  requireExecutionCapabilities(policy, {});
  return executionPolicy(policy.mode, {
    files: policy.files,
    image: policy.image,
    requestedNetwork: policy.requestedNetwork,
  });
}
export function currentExecutionPolicy(): ExecutionPolicy | undefined {
  return calls.getStore();
}
export function withExecutionPolicy<T>(policy: ExecutionPolicy | undefined, action: () => T): T {
  return policy ? calls.run(snapshotExecutionPolicy(policy), action) : action();
}
