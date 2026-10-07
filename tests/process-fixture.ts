import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function runCli(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  const options = {
    cwd: projectRoot,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      YUANTU_API_KEY: '',
      YUANTU_MODEL: '',
      /**
       * A window for the fixture endpoint, because a run without one is refused.
       *
       * The window is the only ceiling a run has, so the fixture declares one the way an operator must; a test
       * that means to exercise a window of its own passes `maxContextTokens` to the kernel directly, and one
       * that means to exercise the refusal passes `YUANTU_MAX_CONTEXT_TOKENS: ''` here.
       */
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      ...env,
    },
    windowsHide: true,
  };
  const command = [path.join(projectRoot, 'apps/cli/main.ts'), ...args];
  /**
   * A pipe on standard input only when a test has something to say.
   *
   * `credentials set` is the one command that reads it; every other command should see the same closed stdin it
   * has always had. The two spawns are separate rather than one call with a computed `stdio` because the tuple
   * literal is what tells TypeScript which of the output streams are present.
   */
  const child =
    input === undefined
      ? spawn(process.execPath, command, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, command, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin?.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI test timed out'));
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
