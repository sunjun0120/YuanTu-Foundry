/**
 * `npm run i18n:check`: the language gate over the interface's own process.
 *
 * The rule, the exceptions and the reasoning live in `./i18n-gate.mjs`, which is importable so the tests can run it
 * over a small tree of their own — this file only turns its answer into an exit code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanI18n } from './i18n-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = await scanI18n(root);
if (problems.length) {
  console.error('i18n:check failed:\n' + problems.map((line) => `  - ${line}`).join('\n'));
  process.exitCode = 1;
} else console.log('i18n:check passed');
