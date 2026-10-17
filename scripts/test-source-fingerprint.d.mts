export function sourceFingerprint(root: string): Promise<{
  algorithm: string;
  digest: string;
  files: number;
}>;
