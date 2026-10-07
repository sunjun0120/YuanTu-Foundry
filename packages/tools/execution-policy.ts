import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ExecutionPolicy,
  ExecutionMode,
  ExecutionCapabilities,
  FileEffect,
} from '../protocol/execution.ts';

const calls = new AsyncLocalStorage<ExecutionPolicy>();
const capabilities: Record<ExecutionMode, ExecutionCapabilities> = {
  host: {
    processFiles: 'unrestricted',
    network: 'unrestricted',
    pathKind: 'local',
    links: 'refused',
  },
  windows: {
    processFiles: 'workspace-write-partial',
    network: 'unrestricted',
    pathKind: 'local',
    links: 'refused',
  },
  docker: { processFiles: 'read-only', network: 'denied', pathKind: 'local', links: 'refused' },
  sbx: { processFiles: 'read-only', network: 'denied', pathKind: 'local', links: 'refused' },
};
export function executionPolicy(
  mode: ExecutionMode,
  options: { files?: FileEffect; image?: string } = {},
): ExecutionPolicy {
  const supported = capabilities[mode];
  if (!supported) throw new Error('Unknown execution backend');
  const image = options.image ?? 'node:24-bookworm-slim';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
    throw new Error('Invalid sandbox image');
  if (
    options.files !== undefined &&
    options.files !== 'read-only' &&
    options.files !== 'workspace-write'
  )
    throw new Error('Invalid file policy');
  return Object.freeze({
    mode,
    image,
    files: options.files ?? 'workspace-write',
    processFiles: supported.processFiles,
    network: supported.network,
  });
}
export function requireExecutionCapabilities(
  policy: ExecutionPolicy,
  required: Partial<Pick<ExecutionCapabilities, 'processFiles' | 'network'>>,
): void {
  const actual = capabilities[policy.mode];
  if (!actual || policy.processFiles !== actual.processFiles || policy.network !== actual.network)
    throw new Error('Execution backend cannot enforce the declared policy');
  if (required.processFiles && required.processFiles !== actual.processFiles)
    throw new Error('Backend filesystem capability does not satisfy this call');
  if (required.network && required.network !== actual.network)
    throw new Error('Backend network capability does not satisfy this call');
}
export function snapshotExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  requireExecutionCapabilities(policy, {});
  return executionPolicy(policy.mode, policy);
}
export function currentExecutionPolicy(): ExecutionPolicy | undefined {
  return calls.getStore();
}
export function withExecutionPolicy<T>(policy: ExecutionPolicy, action: () => T): T {
  return calls.run(snapshotExecutionPolicy(policy), action);
}
