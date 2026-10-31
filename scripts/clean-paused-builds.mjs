/** Remove stale generated output for entry points that were removed from the source tree before building. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const removedMcpModules = [
  'main-mcp',
  'mcp-contract',
  'mcp-settings',
  'mcp-test-worker',
  'renderer-mcp',
];
const removedBackupModules = [
  'backup-contract',
  'daily-backups',
  'main-backups',
  'database-backup-worker',
  'renderer-backups',
];
const removedOfficeModules = [
  'automation',
  'document',
  'inspect',
  'inspect-runner',
  'inspect-worker',
  'limits',
  'presentation',
  'preview',
  'preview-backends',
  'replace',
  'tools',
  'xml-text',
];
const removedOutputs = [
  'apps/web',
  'apps/agent-acp',
  'packages/sdk',
  'desktop/img',
  ...[...removedMcpModules, ...removedBackupModules].flatMap((name) =>
    ['.js', '.js.map', '.d.ts'].map((extension) => `apps/desktop/${name}${extension}`),
  ),
  'packages/tools/sandbox-windows.js',
  'packages/tools/sandbox-windows.js.map',
  'packages/tools/sandbox-windows.d.ts',
  'desktop/database-backup-worker.cjs',
  'desktop/database-backup-worker.cjs.map',
  'desktop/mcp-test-worker.cjs',
  'desktop/mcp-test-worker.cjs.map',
  ...removedOfficeModules.flatMap((name) =>
    ['.js', '.js.map', '.d.ts'].map((extension) => `packages/office/${name}${extension}`),
  ),
  'packages/office/automation.ps1',
  'packages/tools/office-inspect-worker.js',
  'packages/tools/office-inspect-worker.js.map',
  'packages/tools/automation.ps1',
  'desktop/automation.ps1',
];
for (const relative of removedOutputs) {
  const target = path.resolve(output, relative);
  const within = path.relative(output, target);
  if (!within || within.startsWith('..') || path.isAbsolute(within))
    throw new Error(`Refusing to clean output outside dist: ${target}`);
  await rm(target, { recursive: true, force: true });
}
