#!/usr/bin/env node
/**
 * Fail when a production dependency carries a high or critical advisory nobody has looked at.
 *
 * `npm audit --audit-level=high` alone cannot be a gate here: some advisories have no fix that does not break the
 * dependent package, and a gate that is red for a known, weighed reason is a gate people learn to skip. Each such
 * advisory is listed below with why it is tolerated, so the list itself is the record of that decision, and an
 * entry that no longer appears in the report is reported as stale so the exemption cannot outlive its reason.
 */
import { execSync } from 'node:child_process';

const ACCEPTED = new Map([
  [
    'GHSA-5p2g-fcmc-qvqq',
    'image-size via pptxgenjs: only 2.x is patched and pptxgenjs depends on the 1.x API; PPTX output embeds no images',
  ],
  [
    'GHSA-w3rx-r6r6-pgpr',
    'image-size via pptxgenjs: same as above; the ICNS parser is only reached for embedded images',
  ],
]);

let report;
try {
  let out;
  try {
    // A fixed command string: nothing here comes from input, and `npm` resolves to npm.cmd through the shell.
    out = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON on stdout is still the answer.
    out = error.stdout;
    if (!out) throw error;
  }
  report = JSON.parse(out);
} catch (error) {
  console.error(`audit:check could not read the advisory report: ${error.message}`);
  process.exit(1);
}
if (report.error) {
  console.error(
    `audit:check: npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`,
  );
  process.exit(1);
}

const seen = new Set();
const problems = [];
for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of entry.via) {
    if (typeof via === 'string') continue;
    const id = String(via.url ?? '')
      .split('/')
      .pop();
    seen.add(id);
    if (via.severity !== 'high' && via.severity !== 'critical') continue;
    if (ACCEPTED.has(id)) continue;
    problems.push(`${name}: ${via.severity} ${id} ${via.title}`);
  }
}
for (const id of ACCEPTED.keys())
  if (!seen.has(id))
    problems.push(`${id} is accepted but no longer reported; remove it from the list`);

if (problems.length) {
  console.error('audit:check failed:\n' + problems.map((line) => `  - ${line}`).join('\n'));
  process.exit(1);
}
console.log(`audit:check ok (${ACCEPTED.size} accepted advisories)`);
