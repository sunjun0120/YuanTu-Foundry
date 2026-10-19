/**
 * The composer's verification form turns text into the contract the carrier accepts.
 *
 * The wiring is a DOM form, but the conversion — one command per line, paths split on commas, ids stable within
 * one draft — is ordinary logic and is pinned here without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationDraft } from '../apps/desktop/renderer-verification.ts';

test('commands become command checks with stable ids', () => {
  const draft = verificationDraft({
    commands: 'npm test\n npm run lint ',
    inputs: 'src, package.json，src',
    includeObjective: true,
    objective: 'Make the change',
    defaultObjective: 'The request',
  });
  assert.deepEqual(
    draft.acceptance.map((item) => item.check),
    [
      { id: 'check-1', kind: 'command', command: 'npm test' },
      { id: 'check-2', kind: 'command', command: 'npm run lint' },
    ],
  );
  assert.equal(
    draft.acceptance.every((item) => item.met === false),
    true,
  );
  assert.deepEqual(draft.inputs, ['src', 'package.json']);
  assert.equal(draft.objective, 'Make the change');
});

test('an empty command list is refused rather than sent as an unverified request', () => {
  assert.throws(
    () =>
      verificationDraft({
        commands: '\n  \n',
        inputs: '',
        includeObjective: true,
        defaultObjective: '',
      }),
    /至少需要一条命令|at least one command/i,
  );
});

test('the objective falls back to the request and a plan omits it', () => {
  const fromPrompt = verificationDraft({
    commands: 'npm test',
    inputs: '',
    includeObjective: true,
    objective: '   ',
    defaultObjective: 'Fix the price',
  });
  assert.equal(fromPrompt.objective, 'Fix the price');
  const plan = verificationDraft({
    commands: 'npm test',
    inputs: '',
    includeObjective: false,
    defaultObjective: '',
  });
  assert.equal('objective' in plan, false);
});
