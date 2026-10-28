// Product-scope-gated cases keep their bodies so re-enabling a paused surface restores coverage without a rewrite.
/**
 * The environment this process reads: one owner for its defaults, and a loud failure for anything else.
 *
 * Two failures motivated this. The first is drift: `200` rounds and `1_000_000` tokens were written in the
 * kernel, again in the Host, and a third time in the CLI help text, with nothing comparing them. The second
 * is silence: `YUANTU_MAX_TOKEN` (missing the S) was ignored without a word, so the run used a budget nobody
 * asked for and the mistake only appeared on a bill. These tests pin the owner and the refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ENVIRONMENT,
  RUN_DEFAULTS,
  assertEnvironment,
  environmentProblems,
  parseSetting,
  promptCacheMode,
  resolveRunLimits,
} from '../packages/protocol/settings.ts';
import { readConfig } from '../packages/providers/config.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { projectRoot } from './process-fixture.ts';
import { pausedSkip } from './product-scope-skip.ts';

/** The CLI's own help output, rendered by the code rather than read from a file. */
async function runCli(args: string[]): Promise<string> {
  const child = spawn(process.execPath, [path.join(projectRoot, 'apps/cli/main.ts'), ...args], {
    cwd: projectRoot,
    // A deliberately small environment: the check under test is on the CLI's output, not on whatever the
    // developer's shell happens to export.
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, `the CLI exited ${code}`);
  return stdout;
}

test('workflow polling uses the registered integer range instead of accepting arbitrary numbers', () => {
  assert.equal(parseSetting({}, 'YUANTU_WORKFLOW_INTERVAL_MS'), undefined);
  assert.equal(
    parseSetting({ YUANTU_WORKFLOW_INTERVAL_MS: '' }, 'YUANTU_WORKFLOW_INTERVAL_MS'),
    undefined,
  );
  for (const value of ['1000', '86400000'])
    assert.equal(
      parseSetting({ YUANTU_WORKFLOW_INTERVAL_MS: value }, 'YUANTU_WORKFLOW_INTERVAL_MS'),
      Number(value),
    );
  for (const value of ['0', '999', '-1000', '1000.5', '86400001'])
    assert.throws(
      () => parseSetting({ YUANTU_WORKFLOW_INTERVAL_MS: value }, 'YUANTU_WORKFLOW_INTERVAL_MS'),
      /YUANTU_WORKFLOW_INTERVAL_MS must be an integer between 1000 and 86400000/,
    );
  for (const value of ['Infinity', 'not-a-number'])
    assert.throws(
      () => parseSetting({ YUANTU_WORKFLOW_INTERVAL_MS: value }, 'YUANTU_WORKFLOW_INTERVAL_MS'),
      /YUANTU_WORKFLOW_INTERVAL_MS must be a number/,
    );
});

test('a mistyped name is reported with the one it probably meant', () => {
  const problems = environmentProblems({ YUANTU_MODELS: 'fixture-model', YUANTU_MODEL: 'fixture' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.key, 'YUANTU_MODELS');
  assert.equal(problems[0]!.suggestion, 'YUANTU_MODEL');
  assert.throws(
    () => assertEnvironment({ YUANTU_MODELS: 'fixture-model' }),
    /YUANTU_MODELS: unknown setting; did you mean YUANTU_MODEL\?/,
  );
  // A name for a setting this build deliberately does not have is unknown like any other: there is no round
  // cap and no cumulative run budget, so `YUANTU_MAX_ROUNDS` and `YUANTU_MAX_TOKENS` are refused rather than
  // silently ignored.
  const retired = environmentProblems({ YUANTU_MAX_TOKENS: '5000' });
  assert.equal(retired.length, 1);
  assert.equal(retired[0]!.key, 'YUANTU_MAX_TOKENS');
  assert.equal(environmentProblems({ YUANTU_MAX_ROUNDS: '5' })[0]!.key, 'YUANTU_MAX_ROUNDS');
  // A name that resembles nothing is still refused, and is not given a misleading suggestion.
  const unrelated = environmentProblems({ YUANTU_WHATEVER: '1' });
  assert.equal(unrelated[0]!.suggestion, undefined);
});

test('a known name with an unusable value says what it accepts', () => {
  const problems = environmentProblems({
    YUANTU_PROTOCOL: 'openai-compatible',
    YUANTU_MAX_CONTEXT_TOKENS: '0',
    YUANTU_PROMPT_CACHE: 'maybe',
    YUANTU_STREAM_IDLE_TIMEOUT_MS: '10',
  });
  assert.deepEqual(
    problems.map((entry) => entry.key),
    [
      'YUANTU_MAX_CONTEXT_TOKENS',
      'YUANTU_PROMPT_CACHE',
      'YUANTU_PROTOCOL',
      'YUANTU_STREAM_IDLE_TIMEOUT_MS',
    ],
    'every problem is reported at once, not one restart at a time',
  );
  assert.match(problems[0]!.problem, /between 1 and 100000000/);
  // The cache setting's rule is its own (it grew from a boolean into four modes and still accepts both
  // spellings), so what it says is the mode list — asked of the table's own validator rather than spelled out
  // here, which is the point of that rule living in the table at all.
  assert.match(problems[1]!.problem, /must be one of auto, blocks, key-only, off/);
  assert.match(problems[1]!.problem, /got "maybe"/);
  assert.match(problems[2]!.problem, /anthropic, openai, openai-responses/);
  assert.match(problems[3]!.problem, /between 1000 and 3600000/);
  assert.equal(environmentProblems({ YUANTU_PROTOCOL: 'openai', YUANTU_MODEL: 'm' }).length, 0);
});

test('run limits come from one owner, and an override still wins', () => {
  assert.deepEqual(resolveRunLimits(), RUN_DEFAULTS);
  assert.deepEqual(resolveRunLimits({ maxParallelToolCalls: 3 }), {
    ...RUN_DEFAULTS,
    maxParallelToolCalls: 3,
  });
  for (const invalid of [
    { maxContextTokens: 0 },
    { maxParallelToolCalls: -1 },
    { maxContextChars: 1.5 },
  ])
    assert.throws(() => resolveRunLimits(invalid), /Invalid max/);
});

test('the main request has no timeout unless one is asked for, and the summary always has one', () => {
  /**
   * One number, one owner. `requestTimeoutMs` used to default to 120000 in the defaults table while the main
   * request read the raw option instead — so the number meant "the summary's limit" to one reader and
   * "a limit that is normally unset" to the other, and a main request could look configured without ever
   * having a wall-clock bound.
   */
  assert.equal(resolveRunLimits().requestTimeoutMs, undefined);
  assert.equal(resolveRunLimits({}).summaryTimeoutMs, 120_000);
  assert.equal(resolveRunLimits({ requestTimeoutMs: 5_000 }).requestTimeoutMs, 5_000);
  // An operator's smaller limit is still theirs to set, and it does not take the summary's default with it.
  assert.equal(resolveRunLimits({ summaryTimeoutMs: 30_000 }).summaryTimeoutMs, 30_000);
  assert.throws(() => resolveRunLimits({ requestTimeoutMs: 0 }), /Invalid requestTimeoutMs/);
});

test(
  'the documented defaults are the defaults the code uses',
  { skip: pausedSkip('cli') },
  async () => {
    // The help text is rendered from the constants, so this checks the *rendered* output: a literal number in
    // the help is exactly the drift this module exists to prevent.
    const help = await runCli(['--help']);
    for (const [flag, expected] of [
      ['max-context-chars', RUN_DEFAULTS.maxContextChars],
      ['max-output-tokens', RUN_DEFAULTS.maxOutputTokens],
    ] as const) {
      const line = help.split('\n').find((entry) => entry.includes(`--${flag} <n>`));
      assert.ok(line, `the help text documents --${flag}`);
      assert.match(line, new RegExp(`default: ${expected}\\b`));
    }
    // Omitting the window uses the capacity resolver; the flag remains an explicit override.
    // Help must describe automatic resolution without presenting one endpoint-specific number as universal.
    const windowLine = help.split('\n').find((entry) => entry.includes('--max-context-tokens <n>'));
    assert.ok(windowLine, 'the help text documents --max-context-tokens');
    assert.match(windowLine, /omit.*resolved automatically/);
    assert.doesNotMatch(
      windowLine,
      /default:/,
      'the help should explain resolution rather than hard-code a universal window',
    );
    const cliDirectory = path.join(projectRoot, 'apps/cli');
    const source = (
      await Promise.all(
        (await readdir(cliDirectory))
          .filter((file) => file.endsWith('.ts'))
          .map((file) => readFile(path.join(cliDirectory, file), 'utf8')),
      )
    ).join('\n');
    // A round cap used to be documented here with a default. It is not a limit any more, and a flag for it
    // would be a bound the kernel has no place to enforce.
    assert.ok(
      !/--max-rounds/.test(source),
      'the help text must not offer a round cap the kernel does not have',
    );
  },
);

test('the provider config reports a bad value with the table’s own words', () => {
  // There is one validator, not two that agree: `readConfig` goes through `parseSetting`, so the message it
  // raises *is* the table's message. Before this, each side carried its own bound — and one had already
  // drifted (`YUANTU_MAX_RETRIES` was 0–2 in the config and 0–10 in the table), which a test that only
  // checked "both refuse 99" could not see.
  for (const [key, value, bound] of [
    ['YUANTU_PROTOCOL', 'openai-compatible', 2],
    ['YUANTU_PROMPT_CACHE', 'maybe', 0],
    ['YUANTU_STREAM_IDLE_TIMEOUT_MS', '10', 3],
  ] as const) {
    const env = {
      YUANTU_API_KEY: 'k',
      YUANTU_MODEL: 'm',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      [key]: value,
    };
    const fromTable = environmentProblems(env).find((entry) => entry.key === key)?.problem;
    assert.ok(fromTable, `the environment table refuses ${key}=${value}`);
    assert.throws(
      () => readConfig(env),
      (error: unknown) => error instanceof Error && error.message === fromTable,
      `readConfig refuses ${key}=${value} with the table's words (${bound} checks)`,
    );
  }
  /**
   * `YUANTU_MAX_RETRIES` used to be in that list, and it is not any more for a reason worth pinning: the retry
   * allowance is a *run* limit now, read by `resolveRunLimits` through `parseArgs`, so the provider config no
   * longer looks at it at all. The table still refuses a bad value — that is what a setter reports — and the
   * reader that does own it refuses it too (`tests/retry.test.ts`).
   */
  assert.ok(environmentProblems({ YUANTU_MAX_RETRIES: '9' })[0]?.problem);
  assert.doesNotThrow(() =>
    readConfig({
      YUANTU_API_KEY: 'k',
      YUANTU_MODEL: 'm',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_MAX_RETRIES: '9',
    }),
  );
  assert.equal(parseArgs([], { YUANTU_MAX_RETRIES: '5' }).options.maxModelRetries, 5);
  // The ceiling is the table's too, which it was not before: this parser used to check only the floor, so a
  // value the doctor called invalid ran anyway.
  assert.throws(() => parseArgs([], { YUANTU_MAX_RETRIES: '9' }), /at most 5/);
  assert.throws(() => parseArgs(['--max-retries', '9']), /at most 5/);
  /**
   * The investigation allowance is a run limit too, and the two new settings that only the run reads behave the
   * same way: the table is what refuses a bad value, and the parser that owns each one refuses the values a run
   * would otherwise accept above the declared ceiling.
   */
  for (const [key, value, ceiling] of [
    ['YUANTU_INVESTIGATION_MS', '999', 3_600_000],
    ['YUANTU_INVESTIGATION_MS', '3600001', 3_600_000],
    ['YUANTU_ZERO_BYTE_RETRIES', '4', 3],
    ['YUANTU_ZERO_BYTE_RETRIES', '-1', 0],
  ] as const) {
    const problem = environmentProblems({ [key]: value }).find(
      (entry) => entry.key === key,
    )?.problem;
    assert.ok(problem, `the environment table refuses ${key}=${value}`);
    // The lower bound of `YUANTU_INVESTIGATION_MS` is the table's alone: the parser's floor is "positive", as it
    // is for every other number in it, so only the ceiling is asserted here.
    if (Number(value) > ceiling)
      assert.throws(() => parseArgs([], { [key]: value }), /at most/, `refuses ${key}=${value}`);
  }
  assert.equal(
    parseArgs([], { YUANTU_INVESTIGATION_MS: '240000' }).options.investigationMs,
    240_000,
  );
  assert.equal(parseArgs([], { YUANTU_ZERO_BYTE_RETRIES: '0' }).options.zeroByteRetries, 0);
  // The boundaries themselves, so a bound cannot be widened on one side only: 2 retries are allowed, 3 are
  // not; an empty value means "not set" for both readers rather than an invalid number.
  assert.deepEqual(environmentProblems({ YUANTU_STREAM_IDLE_TIMEOUT_MS: '' }), []);
  assert.equal(
    readConfig({
      YUANTU_API_KEY: 'k',
      YUANTU_MODEL: 'm',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_STREAM_IDLE_TIMEOUT_MS: '',
    }).streamIdleTimeoutMs,
    undefined,
  );
});

test('every YUANTU_* name the project reads is registered', async () => {
  const files = [];
  for (const directory of ['apps', 'packages', 'tests', 'scripts', 'examples']) {
    for (const entry of await readdir(path.join(projectRoot, directory), { withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name))
        files.push(path.join(directory, entry.name));
      else if (entry.isDirectory()) {
        for (const name of await readdir(path.join(projectRoot, directory, entry.name)))
          if (/\.(ts|mjs)$/.test(name)) files.push(path.join(directory, entry.name, name));
      }
    }
  }
  const seen = new Set<string>();
  for (const file of files) {
    const text = await readFile(path.join(projectRoot, file), 'utf8');
    // The settings module names the keys it owns; this file deliberately contains misspelled names.
    if (file.endsWith('settings.ts') || file.endsWith('environment.test.ts')) continue;
    for (const match of text.matchAll(/YUANTU_[A-Z0-9_]+/g)) seen.add(match[0]);
  }
  const unregistered = [...seen].filter((key) => !(key in ENVIRONMENT)).sort();
  assert.deepEqual(
    unregistered,
    [],
    'a setting read anywhere in the project must be registered, or the environment check would refuse a key the code needs',
  );
});

test('a cache mode inherited from Object.prototype is not a mode', () => {
  /**
   * The alias table is a plain object and the lookup was a bare subscript, so `Object.prototype` was in the chain.
   * Lower-casing does not remove the two names that are already lower case: `constructor` resolved to the `Object`
   * function and `__proto__` to an object, both truthy — so the environment check that exists to refuse a
   * misspelling admitted one, and handed a function to code that expects a mode.
   */
  for (const inherited of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])
    assert.equal(
      promptCacheMode(inherited),
      undefined,
      `${inherited} is not a cache mode, it is a name off the prototype`,
    );
  // The real vocabulary still resolves, aliases included, so the guard did not narrow the setting itself.
  assert.equal(promptCacheMode('blocks'), 'blocks');
  assert.equal(promptCacheMode('key-only'), 'key-only');
  assert.equal(promptCacheMode('off'), 'off');
  assert.equal(promptCacheMode('auto'), 'auto');
  assert.equal(promptCacheMode('  BLOCKS  '), 'blocks', 'trimmed and lower-cased as before');
  assert.equal(promptCacheMode('nonsense'), undefined);
  assert.equal(promptCacheMode(''), undefined);
  // And the environment refuses the spelling rather than accepting it as a mode.
  assert.throws(() => assertEnvironment({ YUANTU_PROMPT_CACHE: 'constructor' }));
});
