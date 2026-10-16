import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTestIsolation } from './test-isolation-lint.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = await lintTestIsolation(root);
for (const issue of issues)
  console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
console.log(`test-isolation: ${issues.length} violation(s)`);
process.exitCode = issues.length ? 1 : 0;
