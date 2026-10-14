import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, stat, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const [id, directory] = process.argv.slice(2);
const checks = [];
const temporary = await mkdtemp(path.join(tmpdir(), 'coding-oracle-'));
const load = (relative) => import(pathToFileURL(path.join(directory, relative)).href);
async function check(id, action) {
  try {
    await action();
    checks.push({ id, passed: true, evidence: 'independent behavior assertion passed' });
  } catch (error) {
    checks.push({
      id,
      passed: false,
      evidence: error instanceof Error ? error.message : String(error),
    });
  }
}
try {
  if (['E01', 'E05', 'E07', 'E09', 'E10'].includes(id)) {
    const { spillOutput, spillResult } = await load('packages/tools/spill.ts');
    const spill = (content, sessionId = 's', retentionLimit) =>
      spillOutput({
        workspace: temporary,
        sessionId,
        tool: '../../工具🛠',
        content,
        ...(retentionLimit === undefined ? {} : { retentionLimit }),
      });
    for (const [name, content] of [
      ['cjk', '中文'.repeat(1_500_000)],
      ['emoji', '😀'.repeat(2_100_000)],
      ['mixed', 'a中😀'.repeat(1_100_000)],
      ['ascii', 'a'.repeat(8_000_010)],
      ['small', '中文😀\nsmall'],
    ])
      await check(`byte-cap-${name}`, async () => {
        const result = spill(content, name);
        assert.ok(result);
        const actual = await readFile(path.join(temporary, result.path), 'utf8');
        const info = await stat(path.join(temporary, result.path));
        assert.ok(info.size <= 8_000_000, `${name}: byte cap exceeded (${info.size})`);
        assert.equal(result.bytes, info.size);
        assert.ok(content.startsWith(actual));
        assert.equal(actual.includes('\ufffd'), false);
        if (Buffer.byteLength(content) <= 8_000_000) assert.equal(actual, content);
        if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
      });
    await check('stable-original-result', async () => {
      const input = {
        workspace: temporary,
        sessionId: 'result',
        key: 'tool-call',
        content: 'original\n中文😀',
      };
      const a = spillResult(input);
      const b = spillResult(input);
      assert.deepEqual(a, b);
      assert.equal(await readFile(path.join(temporary, a.path), 'utf8'), input.content);
    });
    await check('default-retention-50', async () => {
      for (let n = 0; n < 53; n++) spill(String(n), 'default');
      assert.equal((await readdir(path.join(temporary, '.yuantu/spill/default'))).length, 50);
    });
    if (['E05', 'E09', 'E10'].includes(id)) {
      await check('retention-2-is-session-scoped', async () => {
        const other = spill('other', 'other', 1);
        for (let n = 0; n < 3; n++) spill(String(n), 'two', 2);
        assert.equal((await readdir(path.join(temporary, '.yuantu/spill/two'))).length, 2);
        assert.equal(await readFile(path.join(temporary, other.path), 'utf8'), 'other');
      });
      await check('retention-valid-boundaries', async () => {
        assert.ok(spill('one', 'one', 1));
        assert.ok(spill('thousand', 'thousand', 1000));
      });
      await check('retention-invalid-before-write', async () => {
        for (const value of [0, 1001, 1.1, NaN, Infinity, null, '2', false]) {
          assert.throws(() => spill('invalid', 'invalid', value));
        }
        await assert.rejects(stat(path.join(temporary, '.yuantu/spill/invalid')));
      });
      await check('retention-order-codepoints-and-mtime', async () => {
        const dir = path.join(temporary, '.yuantu/spill/order');
        await mkdir(dir, { recursive: true });
        const names = ['z.txt', '😀.txt', '\ue000.txt'];
        for (const name of names) {
          await writeFile(path.join(dir, name), name);
          await utimes(path.join(dir, name), 1_500_000_000, 1_500_000_000);
        }
        spill('newest', 'order', 2);
        const retained = await readdir(dir);
        assert.equal(retained.length, 2);
        assert.ok(retained.includes('😀.txt'));
        assert.ok(!retained.includes('\ue000.txt'));
        assert.ok(!retained.includes('z.txt'));
      });
    }
    if (id === 'E07') {
      await check('refactor-format-behavior', async () => {
        const { truncateUtf8, spillName } = await load('packages/tools/spill-format.ts');
        for (const input of ['abc', '中😀文', '😀😀', '中文'])
          for (let max = 0; max < 20; max++) {
            const actual = truncateUtf8(input, max);
            assert.ok(Buffer.byteLength(actual) <= max);
            assert.ok(input.startsWith(actual));
            assert.equal(actual.includes('\ufffd'), false);
          }
        const names = new Set();
        for (let n = 0; n < 100; n++) {
          const name = spillName('../../A😃B');
          assert.match(name, /^[a-zA-Z0-9_-]+\.txt$/);
          names.add(name);
        }
        assert.equal(names.size, 100);
      });
    }
  } else if (id === 'E02') {
    const { codeForHttpStatus } = await load('packages/protocol/failure.ts');
    for (const [code, expected] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate-limit'],
      [500, 'server'],
      [502, 'server'],
      [503, 'server'],
      [400, 'http'],
      [404, 'http'],
    ])
      await check(`http-${code}`, () => assert.equal(codeForHttpStatus(code), expected));
  } else if (id === 'E03') {
    const { automaticOutputBudget, AUTOMATIC_CONTEXT_TOKENS, AUTOMATIC_OUTPUT_TOKENS } = await load(
      'packages/providers/automatic-capacity.ts',
    );
    await check('capacity-constants', () => {
      assert.equal(AUTOMATIC_CONTEXT_TOKENS, 1_000_000);
      assert.equal(AUTOMATIC_OUTPUT_TOKENS, 256_000);
    });
    for (const [input, expected] of [
      [128000, 32000],
      [32000, 8000],
      [1_000_000, 256000],
      [2_000_000, 256000],
      [7, 1],
      [11, 2],
      [999999, 249999],
    ])
      await check(`capacity-${input}`, () => assert.equal(automaticOutputBudget(input), expected));
  } else if (id === 'E04') {
    const { presentTool } = await load('packages/tools/present.ts');
    await writeFile(path.join(temporary, 'a.txt'), 'a');
    await writeFile(path.join(temporary, 'b.txt'), 'b');
    for (const [name, files, reject] of [
      ['duplicate', ['a.txt', './a.txt'], true],
      ['different', ['a.txt', 'b.txt'], false],
      ['missing', ['a.txt', 'missing.txt'], true],
      ['outside', ['a.txt', '../outside.txt'], true],
    ])
      await check(`delivery-${name}`, async () => {
        const declarations = [];
        const result = await presentTool(temporary).execute(
          { files: files.map((file) => ({ path: file })) },
          {
            signal: new AbortController().signal,
            approve: async () => true,
            deliverables: { read: () => [], write: (files) => declarations.push(files) },
          },
        );
        assert.equal(result.isError, reject);
        assert.equal(declarations.length, reject ? 0 : 1);
        if (!reject) assert.equal(declarations[0].length, 2);
      });
  } else if (id === 'E08') {
    /**
     * E08 is a read-only investigation, so its oracle grades a *report* against facts that can be re-read from
     * the frozen source. Every claim must carry a path, a line range and an excerpt that really exists there:
     * copying a number without evidence scores zero, and a fabricated excerpt fails the check outright.
     *
     * The rubric below is versioned against the frozen corpus's own limits. The previous five-fact rubric
     * (1000-candidate search cap, whole-file read limited to a 256000-byte prefix) no longer describes this
     * source — search reads to EOF and its candidate budget is 200000 entries — so scoring it would fail an
     * accurate report. `/rubric-facts.json` is written next to the result for later review.
     */
    const rubric = [
      {
        id: 'file-listing-page-1000',
        path: 'packages/tools/files.ts',
        matches: /maximum: MAX_LIST_FILES_LIMIT/,
        needles: ['MAX_LIST_FILES_LIMIT', '1_000'],
      },
      {
        id: 'directory-walk-entries-5000',
        path: 'packages/search/inventory.ts',
        matches: /export const LEGACY_MAX_ENTRIES = 5_000;/,
        needles: ['LEGACY_MAX_ENTRIES'],
      },
      {
        id: 'directory-walk-files-1000',
        path: 'packages/search/inventory.ts',
        matches: /export const LEGACY_MAX_FILES = 1_000;/,
        needles: ['LEGACY_MAX_FILES'],
      },
      {
        id: 'search-candidate-budget-200000',
        path: 'packages/search/inventory.ts',
        matches: /export const SEARCH_MAX_ENTRIES = 200_000;/,
        needles: ['SEARCH_MAX_ENTRIES'],
      },
      {
        id: 'regex-file-budget-10000',
        path: 'packages/tools/files.ts',
        matches: /const REGEX_MAX_FILES = 10_000;/,
        needles: ['REGEX_MAX_FILES'],
      },
      {
        id: 'reader-prefix-256000',
        path: 'packages/tools/files.ts',
        matches: /async read\(input: string, limit = 256_000/,
        needles: ['256_000'],
      },
      {
        id: 'match-line-cap-500',
        path: 'packages/search/text.ts',
        matches: /export const MAX_MATCH_TEXT = 500;/,
        needles: ['MAX_MATCH_TEXT'],
      },
      {
        id: 'knowledge-document-cap-64',
        path: 'packages/knowledge/store.ts',
        matches: /if \(count >= 64\) throw new Error\('Document limit reached \(64\)'\);/,
        needles: ['64'],
      },
      {
        id: 'knowledge-result-cap-20',
        path: 'packages/knowledge/store.ts',
        matches: /if \(!Number\.isSafeInteger\(limit\) \|\| limit < 1 \|\| limit > 20\)/,
        needles: ['20'],
      },
    ];
    const declared = [];
    for (const fact of rubric) {
      try {
        const content = await readFile(path.join(directory, fact.path), 'utf8');
        const lines = content.split('\n');
        const line = lines.findIndex((text) => fact.matches.test(text));
        if (line < 0) throw new Error(`${fact.path} no longer contains this limit`);
        declared.push({
          ...fact,
          line: line + 1,
          excerpt: lines[line].trim(),
          needles: fact.needles,
        });
      } catch (error) {
        declared.push({ ...fact, line: null, excerpt: null, problem: String(error) });
      }
    }
    // The declared facts travel inside the result rather than into the graded directory: the oracle must not
    // change the workspace it is judging, or it would itself become a scope violation.
    await check('rubric-facts-readable', () =>
      assert.ok(
        declared.every((fact) => fact.line !== null),
        `unreadable rubric facts: ${declared
          .filter((fact) => fact.line === null)
          .map((fact) => fact.id)
          .join(', ')}`,
      ),
    );
    let report = null;
    await check('analysis-report-present', async () => {
      report = JSON.parse(await readFile(path.join(directory, 'evaluation-analysis.json'), 'utf8'));
      assert.ok(Array.isArray(report.findings));
      assert.ok(
        report.findings.length >= 4,
        `at least 4 findings required, saw ${report.findings.length}`,
      );
      assert.ok(Array.isArray(report.recommendations));
    });
    if (report) {
      const described = new Set();
      for (const [index, finding] of report.findings.entries()) {
        await check(`finding-${index + 1}-evidence`, async () => {
          for (const field of ['claim', 'path', 'excerpt', 'reproduction'])
            assert.equal(
              typeof finding[field],
              'string',
              `finding ${index + 1} needs a string ${field}`,
            );
          assert.ok(
            !path.isAbsolute(finding.path) && !finding.path.includes('..'),
            'finding path must be workspace-relative',
          );
          assert.ok(Number.isSafeInteger(finding.startLine) && finding.startLine >= 1);
          assert.ok(Number.isSafeInteger(finding.endLine) && finding.endLine >= finding.startLine);
          const lines = (await readFile(path.join(directory, finding.path), 'utf8')).split('\n');
          assert.ok(finding.endLine <= lines.length, 'line range exceeds the file');
          const excerpt = lines.slice(finding.startLine - 1, finding.endLine).join('\n');
          assert.ok(
            excerpt.includes(finding.excerpt.trim()) ||
              finding.excerpt.trim().includes(lines[finding.startLine - 1].trim()),
            'excerpt does not occur at the cited lines',
          );
          assert.ok(finding.reproduction.trim().length >= 8, 'a reproduction is required');
          /**
           * Recognise which rubric fact a finding is about.
           *
           * Two independent signals, because a report written by a model words things differently from the
           * reference: the claim names the identifier that carries the limit, or it names a number that occurs in
           * the source it actually cited. Anything else — including a correct-looking sentence about a *different*
           * file, or a number that the cited lines do not contain — leaves the fact undescribed, which is the
           * point: the rubric scores evidence rather than vocabulary.
           */
          const cited = lines.slice(finding.startLine - 1, finding.endLine).join('\n');
          const citedPlain = cited.replaceAll('_', '');
          for (const fact of declared) {
            if (!fact.line || finding.path !== fact.path) continue;
            const namesIdentifier = fact.needles.some((needle) => finding.claim.includes(needle));
            const namesNumber = (finding.claim.match(/\d[\d_,]*/g) ?? []).some((number) => {
              const plain = number.replaceAll('_', '').replaceAll(',', '');
              return plain.length >= 2 && citedPlain.includes(plain);
            });
            if (namesIdentifier || namesNumber) described.add(fact.id);
          }
        });
      }
      for (const fact of declared)
        await check(`rubric-fact-${fact.id}`, () =>
          assert.ok(described.has(fact.id), `no finding cites ${fact.path} for ${fact.id}`),
        );
      await check('report-scope-is-read-only', async () => {
        assert.ok(
          report.recommendations.every(
            (item) => typeof item === 'string' && item.trim().length > 0,
          ),
        );
      });
    }
  } else if (id === 'E06' || id === 'E10') {
    /**
     * E06's requirement lives in the CLI's argument parser, which is importable on its own even though the CLI
     * entry point is paused (`PRODUCT_SCOPE.cli`). That is the boundary the oracle scores: the option, its
     * validation and its command scope. A sample that implemented nothing fails here, and a sample that wired the
     * rest of the product around a paused surface cannot pass by other means.
     *
     * When E10 runs, this same check is one of its two themes, so the oracle for E10 is E06's plus E05's.
     */
    const { parseArgs } = await load('apps/shared/args.ts');
    await check('prompt-file-option-accepted', () => {
      const parsed = parseArgs(['run', '--prompt-file', 'notes/prompt.txt'], {});
      assert.equal(parsed.options.promptFile, 'notes/prompt.txt');
      assert.deepEqual(parsed.positionals, ['run']);
    });
    await check('prompt-file-works-for-resume', () => {
      const parsed = parseArgs(['resume', 'session-id', '--prompt-file', 'p.txt'], {});
      assert.equal(parsed.options.promptFile, 'p.txt');
      assert.deepEqual(parsed.positionals, ['resume', 'session-id']);
    });
    await check('prompt-file-missing-value-refused', () =>
      assert.throws(() => parseArgs(['run', '--prompt-file'], {})),
    );
    await check('positional-prompt-unchanged', () => {
      const parsed = parseArgs(['run', '你好', '--json'], {});
      assert.deepEqual(parsed.positionals, ['run', '你好']);
      assert.equal(parsed.options.json, true);
    });
    if (id === 'E10') {
      const { spillOutput } = await load('packages/tools/spill.ts');
      await check('e10-spill-retention-requirement', () => {
        const output = spillOutput({
          workspace: temporary,
          sessionId: 'e10',
          tool: 'tool',
          content: 'x',
          retentionLimit: 2,
        });
        assert.ok(output);
      });
      await check('e10-retention-rejects-invalid', () =>
        assert.throws(() =>
          spillOutput({
            workspace: temporary,
            sessionId: 'e10',
            tool: 'tool',
            content: 'x',
            retentionLimit: 0,
          }),
        ),
      );
    }
  } else throw new Error(`Uncertified behavior oracle: ${id}`);
} catch (error) {
  checks.push({ id: 'oracle-load-or-execution', passed: false, evidence: String(error) });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    version: 1,
    caseId: id,
    checks,
    passed: checks.length > 0 && checks.every((check) => check.passed),
  }),
);
process.exitCode = checks.length > 0 && checks.every((check) => check.passed) ? 0 : 1;
