import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CarrierError, CarrierService } from '../packages/carrier/index.ts';
import {
  startupEnvironmentProblems,
  startupEnvironmentCheck,
} from '../apps/desktop/startup-environment.ts';

/**
 * The environment a Host is started with, checked before there is a process to exit.
 *
 * A Host refuses an unknown or invalid `YUANTU_*` name by exiting, and everything a window can say about an exit
 * is "restart" — advice that changes nothing for a name that has to be corrected first. So the desktop validates
 * the environment it is about to hand over and passes the failure as a `startupCheck`; this pins that the check
 * runs *before* anything is spawned, and that what reaches the window is the list rather than a spawn error.
 */

const checkFor = (env: NodeJS.ProcessEnv) =>
  startupEnvironmentCheck(startupEnvironmentProblems(env, {}));

const service = (startupCheck: (() => void) | undefined) =>
  new CarrierService({
    nodePath: process.execPath,
    // A path that cannot be spawned: if the check did not run first, the failure would be about this file.
    hostPath: path.join(process.cwd(), 'never-used-because-the-check-fails.ts'),
    workspace: process.cwd(),
    env: {},
    ...(startupCheck ? { startupCheck } : {}),
  });

test('an invalid startup environment fails the start before a Host process exists', async () => {
  /**
   * A name one keystroke away from a real one, which is the case this exists for: the table names the variable and
   * suggests the spelling it believes was meant. The typo is *computed* from the registered name rather than
   * written out, because `tests/environment.test.ts` refuses any unknown `YUANTU_*` literal anywhere in the
   * project — a deliberate one included.
   */
  const misspelled = 'YUANTU_MAX_RETRIES'.replace(/S$/, '');
  const startupCheck = checkFor({ [misspelled]: '1' });
  assert.ok(startupCheck, 'the misspelled name is a problem the table reports');
  const carrier = service(startupCheck);
  const failure = await carrier.start().then(
    () => assert.fail('the start must fail'),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof CarrierError, String(failure));
  assert.equal(failure.code, 'environmentInvalid');
  const problems = String(failure.values.problems);
  assert.match(problems, new RegExp(misspelled));
  assert.match(problems, /did you mean YUANTU_MAX_RETRIES/);
  // The value itself is never echoed: a startup failure is exactly the kind of text a person pastes into a bug
  // report, and some of those variables hold credentials.
  assert.doesNotMatch(problems, /=1/);
});

test('the window is told through the snapshot, which is what the banner draws', async () => {
  const carrier = service(checkFor({ YUANTU_MAX_CONTEXT_TOKENS: 'not-a-number' }));
  await carrier.start().catch(() => undefined);
  const state = carrier.snapshot;
  assert.equal(state.ready, false);
  assert.equal(state.startupStage, 'failed');
  assert.equal(state.errorDetail?.code, 'environmentInvalid');
  // The snapshot's own error text is the English fallback; the window prefers `carrier.environmentInvalid`.
  assert.match(state.error ?? '', /YUANTU_MAX_CONTEXT_TOKENS/);
  assert.match(String(state.errorDetail?.values.problems), /must be a number/);
});

test('a valid environment passes the check and leaves the start to the Host', async () => {
  assert.equal(checkFor({ YUANTU_MAX_RETRIES: '2' }), undefined);
  // Nothing to assert about the Host itself here: the point is that a clean environment does not fail the start
  // before it begins, which the absence of a check expresses.
});

test('startup validation sees overrides exactly as the Host does', () => {
  assert.deepEqual(
    startupEnvironmentProblems({ YUANTU_MAX_RETRIES: 'invalid' }, { YUANTU_MAX_RETRIES: '2' }),
    [],
  );
  const problems = startupEnvironmentProblems(
    { YUANTU_MAX_RETRIES: '2' },
    { YUANTU_MAX_RETRIES: 'invalid' },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /YUANTU_MAX_RETRIES/);
  assert.doesNotMatch(problems[0]!, /invalid/);
  const secret = 'private-value-with-"quotes"\nand lines';
  const custom = startupEnvironmentProblems({ YUANTU_PROMPT_CACHE: secret }, {});
  assert.equal(custom.length, 1);
  assert.doesNotMatch(custom[0]!, /private-value|quotes|and lines/);
});
