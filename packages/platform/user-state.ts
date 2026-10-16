import { homedir } from 'node:os';
import path from 'node:path';

/** Ordinary user data; native sandbox control directories retain their separate trust boundary. */
export function userStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUANTU_STATE_DIR?.trim();
  if (!configured) return path.join(homedir(), '.yuantu');
  if (!path.isAbsolute(configured)) throw new Error('YUANTU_STATE_DIR must be an absolute path');
  return path.normalize(configured);
}
