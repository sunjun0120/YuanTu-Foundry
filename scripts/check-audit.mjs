#!/usr/bin/env node
/**
 * Fail when code the product ships carries a high or critical advisory nobody has looked at.
 *
 * `npm audit --audit-level=high` alone cannot be a gate here: some advisories have no fix that does not break the
 * dependent package, and a gate that is red for a known, weighed reason is a gate people learn to skip. Each such
 * advisory is listed below with why it is tolerated, so the list itself is the record of that decision, and an
 * entry that no longer appears in the report is reported as stale so the exemption cannot outlive its reason.
 *
 * Each exemption also carries a review date. An advisory that is still reported is still a risk somebody decided
 * to carry, and the reasons behind it (no upstream fix, a code path not reached) change without the report
 * noticing; past the date the gate fails until someone has looked again and moved the date or removed the entry.
 *
 * What ships is not the same as `dependencies`, so `npm audit --omit=dev` is not the scope either. The Host, the
 * Office worker and the attachment worker inline the Office and Markdown libraries, which are devDependencies for
 * exactly that reason (`electron-builder.config.cjs`), and the Electron runtime itself is a devDependency. The gate
 * therefore reads the full report and keeps the advisories whose package is installed at a location the product
 * ships: the production tree, plus the devDependencies in `SHIPPED_DEV`. Every devDependency the product source
 * imports has to be listed there or in `NOT_SHIPPED`, so a newly inlined library cannot fall outside the gate.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ACCEPTED = new Map([
  [
    'GHSA-5p2g-fcmc-qvqq',
    {
      reason:
        'image-size via pptxgenjs: only 2.x is patched and pptxgenjs depends on the 1.x API; PPTX output embeds no images',
      reviewBy: '2027-01-31',
    },
  ],
  [
    'GHSA-w3rx-r6r6-pgpr',
    {
      reason:
        'image-size via pptxgenjs: same as above; the ICNS parser is only reached for embedded images',
      reviewBy: '2027-01-31',
    },
  ],
]);

/**
 * devDependencies whose code reaches users. `tree` inlines the package with everything it depends on; `self` ships
 * what the package stands for but none of its dependencies: the `electron` package is a downloader (its `undici`
 * and `@electron/get` run at install time only), and the binary it fetches carries the package's version, which is
 * what Electron's advisories are filed against.
 */
const SHIPPED_DEV = new Map([
  ['electron', 'self'],
  ['docx', 'tree'],
  ['highlight.js', 'tree'],
  ['jszip', 'tree'],
  ['mammoth', 'tree'],
  ['marked', 'tree'],
  ['pptxgenjs', 'tree'],
  ['xlsx', 'tree'],
]);

/** devDependencies the product source names but does not ship, with why. */
const NOT_SHIPPED = new Map([
  [
    'playwright',
    'optional browser tool: loaded only when the user installs it, never packaged (an external in the Host bundle)',
  ],
]);

// Fixed command strings: nothing here comes from input, and `npm` resolves to npm.cmd through the shell.
function npmJson(command) {
  let out;
  try {
    out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON on stdout is still the answer.
    out = error.stdout;
    if (!out) throw error;
  }
  return JSON.parse(out);
}

const problems = [];

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
for (const name of [...SHIPPED_DEV.keys(), ...NOT_SHIPPED.keys()])
  if (!devDependencies.has(name))
    problems.push(`${name} is listed as a shipped or unshipped devDependency but is not one`);

/** Package names the product source imports, statically or dynamically, including type-only `import('x')`. */
function importedPackages() {
  const names = new Set();
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;
  for (const directory of ['apps', 'packages']) {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
      for (const [, raw] of text.matchAll(specifier)) {
        if (raw.startsWith('node:')) continue;
        const parts = raw.split('/');
        names.add(raw.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
      }
    }
  }
  return names;
}
for (const name of importedPackages())
  if (devDependencies.has(name) && !SHIPPED_DEV.has(name) && !NOT_SHIPPED.has(name))
    problems.push(
      `${name} is a devDependency imported by apps/ or packages/; add it to SHIPPED_DEV or NOT_SHIPPED`,
    );

let report;
let shipped;
try {
  report = npmJson('npm audit --json');
  const selectors = ['.prod'];
  for (const [name, reach] of SHIPPED_DEV) {
    // `#name` would read the dot in `highlight.js` as a dependency-type class.
    selectors.push(`:root > [name='${name}']`);
    if (reach === 'tree') selectors.push(`:root > [name='${name}'] *`);
  }
  shipped = new Set(npmJson(`npm query "${selectors.join(', ')}"`).map((node) => node.location));
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
for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
  if (!(entry.nodes ?? []).some((location) => shipped.has(location))) continue;
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
const today = new Date().toISOString().slice(0, 10);
for (const [id, { reviewBy }] of ACCEPTED) {
  if (!seen.has(id))
    problems.push(`${id} is accepted but no longer reported; remove it from the list`);
  else if (today > reviewBy)
    problems.push(
      `${id} was accepted until ${reviewBy}; review the reason, then move the date or fix it`,
    );
}

if (problems.length) {
  console.error('audit:check failed:\n' + problems.map((line) => `  - ${line}`).join('\n'));
  process.exit(1);
}
console.log(`audit:check ok (${ACCEPTED.size} accepted advisories)`);
