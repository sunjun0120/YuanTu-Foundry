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

// ---- sending state (composer-model) ----
import type { CarrierCommand, CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { DocumentAttachment } from '../apps/desktop/attachment-contract.ts';
import type { ImageAttachment } from '../packages/protocol/index.ts';
import { createComposerController } from '../apps/desktop/ui/composer/composer-model.ts';

function composerFixture(
  options: { running?: boolean; fail?: boolean; defer?: boolean; slash?: 'command' | 'error' } = {},
) {
  let prompt = '';
  const session = { sessionId: 's1' as string | null, running: options.running ?? false };
  const state = { session, workspace: '/w' } as unknown as CarrierSnapshot;
  const calls: CarrierCommand[] = [];
  const errors: (string | null)[] = [];
  const images: ImageAttachment[] = [];
  const documents: DocumentAttachment[] = [];
  let release: ((value: CarrierSnapshot | null) => void) | undefined;
  const controller = createComposerController({
    getState: () => state,
    invoke: async (command) => {
      calls.push(command);
      if (!options.defer) return options.fail ? null : ({} as CarrierSnapshot);
      return new Promise<CarrierSnapshot | null>((resolve) => {
        release = resolve;
      });
    },
    requestRender: () => {},
    setError: (message) => errors.push(message),
    attachments: {
      images: () => [...images],
      documents: () => [...documents],
      hasAny: () => images.length + documents.length > 0,
      clear: () => {
        images.length = 0;
        documents.length = 0;
      },
      restore: (nextImages, nextDocuments) => {
        images.push(...nextImages);
        documents.push(...nextDocuments);
      },
    },
    commands: {
      submitSlash: () =>
        options.slash === 'command'
          ? { command: { type: 'compact' } }
          : options.slash === 'error'
            ? { error: 'refused' }
            : null,
    },
    getPrompt: () => prompt,
    setPrompt: (text) => {
      prompt = text;
    },
    isPromptDisabled: () => false,
    focusPrompt: () => {},
  });
  return {
    controller,
    calls,
    errors,
    images,
    documents,
    session,
    state,
    setPrompt: (text: string) => (prompt = text),
    prompt: () => prompt,
    release: () => release,
  };
}

test('an ordinary send submits once, clears the composer and is not "sending" afterwards', async () => {
  const fixture = composerFixture();
  fixture.setPrompt('hello');
  await fixture.controller.submit();
  assert.deepEqual(fixture.calls, [{ type: 'send', prompt: 'hello', images: [] }]);
  assert.equal(fixture.prompt(), '');
  assert.equal(fixture.controller.isSending(), false);
});

test('a failed send cannot restore a draft into another workspace with the same session id', async () => {
  const fixture = composerFixture({ defer: true });
  fixture.setPrompt('only A');
  const pending = fixture.controller.submit();
  fixture.state.workspace = '/b';
  assert.equal(fixture.controller.isSending(), false);
  fixture.release()?.(null);
  await pending;
  assert.equal(fixture.prompt(), '');
});

test('a message typed while the run is live is queued as a follow-up', async () => {
  const fixture = composerFixture({ running: true, defer: true });
  fixture.setPrompt('later');
  const pending = fixture.controller.submit();
  assert.deepEqual(fixture.calls, [
    { type: 'enqueue', prompt: 'later', images: [], mode: 'follow-up' },
  ]);
  assert.equal(fixture.controller.isQueueBusy(), true);
  fixture.release()?.({} as CarrierSnapshot);
  await pending;
  assert.equal(fixture.controller.isQueueBusy(), false);
});

test('a second submit while the first is in flight sees an empty composer and sends nothing', async () => {
  const fixture = composerFixture({ defer: true });
  fixture.setPrompt('once');
  const first = fixture.controller.submit();
  const second = fixture.controller.submit();
  fixture.release()?.({} as CarrierSnapshot);
  await Promise.all([first, second]);
  assert.equal(fixture.calls.length, 1);
});

test('a failed send gives the text and attachments back to the session that wrote it', async () => {
  const fixture = composerFixture({ fail: true });
  fixture.setPrompt('keep me');
  fixture.images.push({ mimeType: 'image/png', data: 'AAAA', name: 'a.png' } as never);
  await fixture.controller.submit();
  assert.equal(fixture.prompt(), 'keep me');
  assert.equal(fixture.images.length, 1);
  assert.equal(fixture.controller.isSending(), false);
});

test('a failure that lands after a session switch restores nothing', async () => {
  const fixture = composerFixture({ defer: true });
  fixture.setPrompt('from s1');
  const pending = fixture.controller.submit();
  fixture.session.sessionId = 's2';
  fixture.release()?.(null);
  await pending;
  assert.equal(fixture.prompt(), '');
  assert.equal(fixture.controller.isSending(), false);
});

test('"sending" belongs to the session that sent', async () => {
  const fixture = composerFixture({ defer: true });
  fixture.setPrompt('hello');
  const pending = fixture.controller.submit();
  assert.equal(fixture.controller.isSending(), true);
  fixture.session.sessionId = 's2';
  assert.equal(fixture.controller.isSending(), false);
  fixture.release()?.({} as CarrierSnapshot);
  await pending;
});

test('a slash command is sent through the same invoke channel and shows its refusal', async () => {
  const ok = composerFixture({ slash: 'command' });
  ok.setPrompt('/compact');
  await ok.controller.submit();
  assert.deepEqual(ok.calls, [{ type: 'compact' }]);

  const refused = composerFixture({ slash: 'error' });
  refused.setPrompt('/plan');
  await refused.controller.submit();
  assert.deepEqual(refused.calls, []);
  assert.deepEqual(refused.errors, ['refused']);
});

test('stop asks once and only while a run is live', async () => {
  const idle = composerFixture();
  await idle.controller.stop();
  assert.deepEqual(idle.calls, []);
  const running = composerFixture({ running: true, defer: true });
  const first = running.controller.stop();
  await running.controller.stop();
  running.release()?.({} as CarrierSnapshot);
  await first;
  assert.deepEqual(running.calls, [{ type: 'cancel' }]);
});

test('clearing the queue raises the busy flag around the command', async () => {
  const fixture = composerFixture({ defer: true });
  const pending = fixture.controller.clearQueue();
  assert.equal(fixture.controller.isQueueBusy(), true);
  fixture.release()?.({} as CarrierSnapshot);
  await pending;
  assert.equal(fixture.controller.isQueueBusy(), false);
  assert.deepEqual(fixture.calls, [{ type: 'clearQueue' }]);
});
