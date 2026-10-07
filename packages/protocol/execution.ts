/** Permissions describe file-tool effects separately from operating-system process restrictions. */
export type ExecutionMode = 'host' | 'docker' | 'sbx' | 'windows';
export type FileEffect = 'read-only' | 'workspace-write';
export type ProcessFileEffect = FileEffect | 'workspace-write-partial' | 'unrestricted';
export type NetworkEffect = 'denied' | 'unrestricted';
export interface ExecutionPolicy {
  readonly mode: ExecutionMode;
  readonly image: string;
  readonly files: FileEffect;
  readonly processFiles: ProcessFileEffect;
  readonly network: NetworkEffect;
}
export interface ExecutionCapabilities {
  readonly processFiles: ProcessFileEffect;
  readonly network: NetworkEffect;
  readonly pathKind: 'local';
  readonly links: 'refused';
}
