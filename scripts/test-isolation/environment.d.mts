export interface Isolation {
  root: string;
  file: string;
  resources: string[];
  violationPath: string;
  processPath: string;
  env: NodeJS.ProcessEnv;
}
export function createIsolation(
  parentRoot: string,
  file: string,
  resources?: string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Isolation>;
