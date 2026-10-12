/** Permissions describe file-tool effects separately from operating-system process restrictions. */
export type ExecutionMode = 'host' | 'native' | 'windows' | 'seatbelt';
export type FileEffect = 'read-only' | 'workspace-write';
export type ProcessFileEffect = FileEffect | 'workspace-write-partial' | 'unrestricted';
export type NetworkEffect = 'denied' | 'unrestricted';
export interface ExecutionPolicy {
  readonly mode: ExecutionMode;
  readonly image: string;
  readonly files: FileEffect;
  readonly processFiles: ProcessFileEffect;
  readonly network: NetworkEffect;
  /** Explicit requested restriction, distinct from backend capability reporting. */
  readonly requestedNetwork?: NetworkEffect;
}
export interface ExecutionCapabilities {
  readonly processFiles: ProcessFileEffect;
  readonly network: NetworkEffect;
  readonly pathKind: 'local';
  readonly links: 'refused';
}
