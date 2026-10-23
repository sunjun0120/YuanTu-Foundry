export const accountHelper: string;
export function accountAcceptanceSkip(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): string | false;
export function manageWindowsAccounts(
  action: 'setup' | 'check' | 'cleanup',
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: (
      file: string,
      args: string[],
      options: {
        env: NodeJS.ProcessEnv;
        windowsHide: boolean;
        timeout: number;
        maxBuffer: number;
      },
    ) => Promise<{ stdout: string }>;
  },
): Promise<void>;
