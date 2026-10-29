import test from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../apps/desktop/i18n.ts';
import type { CarrierCommand, CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { SessionInfo } from '../packages/protocol/index.ts';
import {
  COLLAPSED_ROWS,
  createSessionSidebarController,
  dialogDescription,
  sessionTitle,
  sessionsFoldable,
  visibleSessions,
} from '../apps/desktop/ui/sessions/session-model.ts';

/**
 * The session sidebar's rules, without a window.
 *
 * The legacy modules rebuilt rows by hand and were exercised through the page; the rules worth pinning are the
 * window over the newest sessions, "a running session does not block switching to another", and the two-step
 * rename/delete dialog (empty name refused, failure keeps the dialog).
 */
function session(id: string, title = ''): SessionInfo {
  return {
    id,
    title,
    createdAt: Date.now() - 60_000,
  } as never;
}

function fixture(options: { fail?: boolean } = {}) {
  const commands: CarrierCommand[] = [];
  const controller = createSessionSidebarController({
    select: async (command) => {
      commands.push(command);
      return options.fail ? null : ({} as CarrierSnapshot);
    },
  });
  const fill = (overrides: { blocked?: boolean; sessions?: SessionInfo[] } = {}) => {
    controller.update({
      sessions: overrides.sessions ?? [
        session('a'),
        session('b'),
        session('c'),
        session('d'),
        session('e'),
        session('f'),
      ],
      currentId: 'a',
      blocked: overrides.blocked ?? false,
    });
  };
  return { controller, commands, fill };
}

test('workspace switches isolate sidebar drafts and close a dialog for a colliding session id', () => {
  const { controller } = fixture();
  const input = { sessions: [session('same')], currentId: 'same', blocked: false };
  controller.update({ ...input, workspaceKey: 'a' });
  controller.openSearch();
  controller.setQuery('only A');
  controller.toggleExpanded();
  controller.openDialog('rename', 'same');
  controller.update({ ...input, workspaceKey: 'b' });
  assert.equal(controller.store.getSnapshot().dialog, null);
  assert.equal(controller.store.getSnapshot().query, '');
  assert.equal(controller.store.getSnapshot().expanded, false);
  controller.update({ ...input, workspaceKey: 'a' });
  assert.equal(controller.store.getSnapshot().query, 'only A');
  assert.equal(controller.store.getSnapshot().expanded, true);
});

test('an untitled session shows the untitled label, never its id', () => {
  assert.equal(sessionTitle(session('abcdef12')), t('ui.untitledSession'));
  const { controller, fill } = fixture();
  fill();
  controller.openDialog('rename', 'b');
  assert.equal(controller.store.getSnapshot().dialog?.title, t('ui.untitledSession'));
});

test('the list is a window of the newest sessions until it is expanded', () => {
  const { controller, fill } = fixture();
  fill();
  const state = controller.store.getSnapshot();
  assert.equal(visibleSessions(state).length, COLLAPSED_ROWS);
  assert.equal(sessionsFoldable(state), true);
  controller.toggleExpanded();
  assert.equal(visibleSessions(controller.store.getSnapshot()).length, 6);
  assert.equal(sessionsFoldable(controller.store.getSnapshot()), true);
});

test('a search shows every match and drops the fold', () => {
  const { controller } = fixture();
  controller.update({
    sessions: [session('a'), session('b'), session('c'), session('d'), session('e'), session('f')],
    currentId: 'a',
    blocked: false,
    searching: true,
  });
  const state = controller.store.getSnapshot();
  assert.equal(visibleSessions(state).length, 6);
  assert.equal(sessionsFoldable(state), false);
});

test('a running session does not stop the person switching to another', async () => {
  const { controller, commands, fill } = fixture();
  fill();
  controller.update({
    sessions: [session('a'), session('b')],
    currentId: 'a',
    blocked: false,
    activity: new Map([['b', { running: true, waiting: 0 }]]),
  });
  await controller.selectSession('b');
  assert.deepEqual(commands, [{ type: 'load', id: 'b' }]);
});

test('a blocked window refuses selection, menus and dialogs', async () => {
  const { controller, commands, fill } = fixture();
  fill({ blocked: true });
  await controller.selectSession('b');
  controller.openMenu('b');
  controller.openDialog('delete', 'b');
  assert.deepEqual(commands, []);
  assert.equal(controller.store.getSnapshot().menuSessionId, null);
  assert.equal(controller.store.getSnapshot().dialog, null);
});

test('the row menu targets one session and closes when a command starts', async () => {
  const { controller, fill } = fixture();
  fill();
  controller.openMenu('c');
  assert.equal(controller.store.getSnapshot().menuSessionId, 'c');
  await controller.selectSession('c');
  assert.equal(controller.store.getSnapshot().menuSessionId, null);
});

test('an empty rename is refused before anything is sent', async () => {
  const { controller, commands, fill } = fixture();
  fill();
  controller.openDialog('rename', 'b');
  controller.setDialogValue('   ');
  await controller.confirmDialog();
  assert.deepEqual(commands, []);
  assert.equal(controller.store.getSnapshot().dialog?.error, t('session.enterName'));
  assert.equal(controller.store.getSnapshot().dialog?.saving, false);
});

test('a rename sends the trimmed title and closes on success', async () => {
  const { controller, commands, fill } = fixture();
  fill();
  controller.openDialog('rename', 'b');
  controller.setDialogValue(' 新名字 ');
  await controller.confirmDialog();
  assert.deepEqual(commands, [{ type: 'rename', id: 'b', title: '新名字' }]);
  assert.equal(controller.store.getSnapshot().dialog, null);
});

test('a failed command keeps the dialog open with the reason', async () => {
  const { controller, fill } = fixture({ fail: true });
  fill();
  controller.openDialog('delete', 'b');
  assert.match(dialogDescription(controller.store.getSnapshot().dialog!), /b|会话|session/i);
  await controller.confirmDialog();
  const dialog = controller.store.getSnapshot().dialog;
  assert.equal(dialog?.error, t('session.operationFailed'));
  assert.equal(dialog?.saving, false);
});

test('the search box owns its open state and sends the query it is given', async () => {
  const { controller, commands, fill } = fixture();
  fill();
  controller.openSearch();
  assert.equal(controller.store.getSnapshot().searchOpen, true);
  controller.setQuery('计划');
  await controller.submitQuery('计划');
  assert.deepEqual(commands.at(-1), { type: 'searchSessions', query: '计划' });
  controller.closeSearch();
  assert.equal(controller.store.getSnapshot().searchOpen, false);
});

test('load more, new session and workspace picker are the same select channel', async () => {
  const { controller, commands, fill } = fixture();
  fill();
  controller.loadMore();
  await controller.createSession();
  await controller.chooseWorkspace();
  assert.deepEqual(commands, [
    { type: 'loadMoreSessions' },
    { type: 'create' },
    { type: 'chooseWorkspace' },
  ]);
});
