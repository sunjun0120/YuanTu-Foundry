import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../apps/desktop/i18n.ts';
import {
  commandItems,
  commandQuery,
  exportPayload,
  paletteItems,
  promptForChoice,
  slashOutcome,
} from '../apps/desktop/ui/composer/command-model.ts';

/**
 * The command vocabulary without the menu or the textarea.
 *
 * The palette and the typed slash line are one vocabulary; these tests pin the parts that are easy to break while
 * moving the menu to React: `/task` is still `/goal`'s alias, a missing description is refused with the sentence
 * naming what was typed, export carries the session id, and attachments never turn a message into a command.
 */
setLocale('zh-CN');

test('the palette lists the four window commands in order', () => {
  assert.deepEqual(
    commandItems().map((item) => item.value),
    ['compact', 'export', 'task', 'plan'],
  );
  assert.ok(commandItems().every((item) => item.kind === 'command'));
});

test('only a line that is exactly a slash query opens the palette', () => {
  assert.equal(commandQuery('/'), '');
  assert.equal(commandQuery('/CO'), 'co');
  assert.equal(commandQuery('/compact'), 'compact');
  assert.equal(commandQuery('/compact now'), undefined);
  assert.equal(commandQuery('/skill:review'), undefined);
  assert.equal(commandQuery('hello /compact'), undefined);
});

test('filtering matches name, description and value, and includes skills', () => {
  const items = paletteItems('/', false, [
    { name: 'review', description: 'Look closely', source: 'project' } as never,
  ]);
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.value}`),
    ['command:compact', 'command:export', 'command:task', 'command:plan', 'skill:review'],
  );
  const filtered = paletteItems('/pla', false, []);
  assert.deepEqual(
    filtered.map((item) => item.value),
    ['plan'],
  );
  // A dismissed menu stays closed until the next keystroke resets it.
  assert.deepEqual(paletteItems('/', true, []), []);
});

test('a chosen row leaves the text a person expects', () => {
  assert.equal(promptForChoice(commandItems()[0]!), '/compact ');
  assert.equal(
    promptForChoice({ kind: 'skill', name: 'review', description: '', value: 'review' }),
    '/skill:review ',
  );
  assert.equal(promptForChoice(commandItems()[1]!), null);
});

test('slash commands map to carrier commands and carry the session id for export', () => {
  assert.deepEqual(slashOutcome('/compact', false, 's1'), { command: { type: 'compact' } });
  assert.deepEqual(slashOutcome('/export', false, 's1'), {
    command: { type: 'export', sessionId: 's1', suggestedName: 'yuantu-session.md' },
  });
  assert.equal(exportPayload(null), null);
});

test('/task is accepted as the honest name and becomes the goal command', () => {
  const outcome = slashOutcome('/task 整理设置页', false, 's1');
  assert.ok(outcome && 'command' in outcome);
  assert.equal(outcome.command.type, 'goal');
  assert.equal(outcome.command.prompt, '整理设置页');
  assert.equal(outcome.command.language, 'zh-CN');
});

test('a missing description is refused with the name that was typed', () => {
  const outcome = slashOutcome('/goal', false, 's1');
  assert.ok(outcome && 'error' in outcome);
  assert.match(outcome.error, /goal/);
  const plan = slashOutcome('/plan', false, 's1');
  assert.ok(plan && 'error' in plan);
  assert.match(plan.error, /plan/);
});

test('ordinary text and lines with attachments are messages, not commands', () => {
  assert.equal(slashOutcome('hello', false, 's1'), null);
  assert.equal(slashOutcome('/compact', true, 's1'), null);
  assert.equal(slashOutcome('/unknown', false, 's1'), null);
});

test('the goal/plan commands carry the interface language they were typed in', () => {
  setLocale('en-US');
  const outcome = slashOutcome('/plan tidy the settings page', false, 's1');
  assert.ok(outcome && 'command' in outcome);
  assert.equal(outcome.command.type, 'plan');
  if (outcome.command.type === 'plan') assert.equal(outcome.command.language, 'en-US');
  setLocale('zh-CN');
  assert.equal(t('ui.createPlan').length > 0, true);
});
