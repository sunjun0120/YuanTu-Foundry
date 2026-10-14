/** Remove only generated output for the paused public entry points before building. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
for (const relative of ['apps/cli', 'apps/web', 'apps/agent-acp', 'packages/sdk']) {
  const target = path.resolve(output, relative);
  const within = path.relative(output, target);
  if (!within || within.startsWith('..') || path.isAbsolute(within))
    throw new Error(`Refusing to clean output outside dist: ${target}`);
  await rm(target, { recursive: true, force: true });
}
