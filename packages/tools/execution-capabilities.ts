import type {
  ExecutionCapabilities,
  ExecutionMode,
  FileEffect,
  NetworkEffect,
} from '../protocol/execution.ts';
import { nativeSandboxBackend } from './sandbox-mode.ts';

export const HOST_CAPABILITIES: ExecutionCapabilities = Object.freeze({
  processFiles: 'unrestricted',
  network: 'unrestricted',
  pathKind: 'local',
  links: 'refused',
});
export const WINDOWS_CAPABILITIES: ExecutionCapabilities = Object.freeze({
  processFiles: 'workspace-write-partial',
  network: 'unrestricted',
  pathKind: 'local',
  links: 'refused',
});

type Configuration = {
  mode: ExecutionMode;
  image: string;
  files?: FileEffect;
  network?: NetworkEffect;
};
export function seatbeltCapabilities(config: Configuration): ExecutionCapabilities {
  return Object.freeze({
    processFiles: config.files ?? 'workspace-write',
    network: config.network ?? 'denied',
    pathKind: 'local',
    links: 'refused',
  });
}
/**
 * The sandbox account backend enforces both file policies and both network policies for real: read-only drops
 * the workspace capability from the token, and a denied network runs the command as the offline account that
 * WFP blocks. Network stays open by default, as `native` on Windows always was.
 */
export function windowsAccountCapabilities(config: Configuration): ExecutionCapabilities {
  return Object.freeze({
    processFiles: config.files ?? 'workspace-write',
    network: config.network ?? 'unrestricted',
    pathKind: 'local',
    links: 'refused',
  });
}
type Declaration = (config: Configuration) => ExecutionCapabilities;
// Standalone file policies can be constructed before process providers are loaded. The built-ins use the
// same declarations; registering a replacement always replaces its declaration, even when it has none.
const declarations = new Map<ExecutionMode, Declaration>([
  ['host', () => HOST_CAPABILITIES],
  ['seatbelt', seatbeltCapabilities],
  ['windows', () => WINDOWS_CAPABILITIES],
  ['windows-account', windowsAccountCapabilities],
  [
    'native',
    (config) => declaredExecutionCapabilities({ ...config, mode: nativeSandboxBackend() }),
  ],
]);

export function registerExecutionCapabilities(
  mode: ExecutionMode,
  declaration?: Declaration,
): void {
  declarations.set(mode, declaration ?? (() => HOST_CAPABILITIES));
}

export function declaredExecutionCapabilities(config: Configuration): ExecutionCapabilities {
  const declaration = declarations.get(config.mode);
  if (!declaration) throw new Error('Unknown execution backend');
  const declared = declaration(config);
  if (
    !declared ||
    !['read-only', 'workspace-write', 'workspace-write-partial', 'unrestricted'].includes(
      declared.processFiles,
    ) ||
    !['denied', 'unrestricted'].includes(declared.network) ||
    declared.pathKind !== 'local' ||
    declared.links !== 'refused'
  )
    throw new Error('Invalid execution backend capability declaration');
  return Object.freeze({
    processFiles: declared.processFiles,
    network: declared.network,
    pathKind: 'local',
    links: 'refused',
  });
}
