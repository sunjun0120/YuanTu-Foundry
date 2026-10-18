import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUIT_DEADLINE_MS,
  QuitDeadlineError,
  withinQuitDeadline,
} from '../apps/desktop/quit-deadline.ts';

test('a quit step that never settles is bounded, and the failure names the step', async () => {
  const started = Date.now();
  await assert.rejects(
    withinQuitDeadline(new Promise<void>(() => {}), 'Host shutdown', 20),
    (error: Error) =>
      error instanceof QuitDeadlineError &&
      /Host shutdown did not finish within 20ms/.test(error.message),
  );
  assert.ok(Date.now() - started < 1_000, 'the wait is the deadline, not the stuck step');
});

test('an absent step resolves immediately and a rejection is passed through unchanged', async () => {
  assert.equal(await withinQuitDeadline(undefined, 'nothing to stop', 20), undefined);
  await assert.rejects(
    withinQuitDeadline(Promise.reject(new Error('boom')), 'step', 1_000),
    /boom/,
  );
});

test('a fast step wins and the default is above the Host client’s own shutdown timeout', async () => {
  assert.equal(await withinQuitDeadline(Promise.resolve('done'), 'fast', 1_000), 'done');
  // The Host client kills an unresponsive Host after ten seconds; a deadline below that would cut off a slow but
  // ordinary shutdown before the client had a chance to end its Host.
  assert.ok(QUIT_DEADLINE_MS > 10_000);
});
