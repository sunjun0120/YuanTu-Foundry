import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  WorkspaceMaintenanceCommand,
  WorkspaceMaintenanceReply,
} from '../apps/desktop/workspace-maintenance-contract.ts';
import type { ArchivedSessionsReply } from '../apps/desktop/contract.ts';
import type { CarrierCommand, CarrierSnapshot } from '../packages/carrier/contract.ts';
import { t } from '../apps/desktop/i18n.ts';
import {
  createWorkspaceSettingsController,
  type WorkspaceSettingsController,
} from '../apps/desktop/ui/settings/workspace-settings-model.ts';

/**
 * The archived-sessions / retained-workspaces page, without a window.
 *
 * The legacy modules were tested through the page's DOM; the interesting rules are not about elements: a reply for
 * the project you just left must be dropped, a rejected IPC must release the controls, and a destructive action asks
 * once before it sends anything. Those live in the controller now.
 */
const archivedReply = (
  workspace: string,
  sessions: { id: string; title?: string; archivedAt?: number }[] = [],
): ArchivedSessionsReply => ({
  ok: true,
  workspace,
  sessions: sessions as never,
});

function controllerFixture(options: {
  maintenance?: (command: WorkspaceMaintenanceCommand) => Promise<WorkspaceMaintenanceReply>;
  archived?: () => Promise<ArchivedSessionsReply>;
  select?: (command: CarrierCommand) => Promise<CarrierSnapshot | null>;
  visible?: boolean;
}) {
  const maintenanceCalls: WorkspaceMaintenanceCommand[] = [];
  const selectCalls: CarrierCommand[] = [];
  const controller: WorkspaceSettingsController = createWorkspaceSettingsController({
    maintenance: async (command) => {
      maintenanceCalls.push(command);
      return options.maintenance
        ? options.maintenance(command)
        : {
            ok: true,
            workspace: controller.store.getSnapshot().workspace,
            items: [],
          };
    },
    archived:
      options.archived ?? (async () => archivedReply(controller.store.getSnapshot().workspace)),
    select: async (command) => {
      selectCalls.push(command);
      return options.select ? options.select(command) : null;
    },
    isVisible: () => options.visible ?? false,
  });
  return { controller, maintenanceCalls, selectCalls };
}

const snapshot = (
  workspace: string,
  extra: { ready?: boolean; running?: boolean; loading?: boolean } = {},
): Pick<CarrierSnapshot, 'workspace' | 'ready' | 'session'> =>
  ({
    workspace,
    ready: extra.ready ?? true,
    session: { running: extra.running ?? false, loading: extra.loading ?? false },
  }) as never;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a project change clears both lists and only loads them when the page is visible', async () => {
  const { controller, maintenanceCalls } = controllerFixture({ visible: false });
  controller.update(snapshot('/one'));
  await flush();
  assert.equal(maintenanceCalls.length, 0);
  controller.update(snapshot('/two'));
  await flush();
  assert.equal(maintenanceCalls.length, 0);
});

test('a visible page reloads both lists when the project changes', async () => {
  const { controller, maintenanceCalls } = controllerFixture({
    visible: true,
    archived: async () => archivedReply('/two'),
  });
  controller.update(snapshot('/one'));
  await flush();
  maintenanceCalls.length = 0;
  controller.update(snapshot('/two'));
  await flush();
  assert.deepEqual(maintenanceCalls, [{ type: 'list' }]);
});

test('a maintenance reply for the previous project is dropped', async () => {
  let release: ((reply: WorkspaceMaintenanceReply) => void) | undefined;
  const { controller } = controllerFixture({
    visible: true,
    maintenance: (command) =>
      command.type === 'list'
        ? new Promise<WorkspaceMaintenanceReply>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ ok: true, workspace: '/one', items: [] }),
  });
  controller.update(snapshot('/one'));
  await flush();
  controller.update(snapshot('/two'));
  await flush();
  release?.({
    ok: true,
    workspace: '/one',
    items: [
      { binding: { id: 'old', executionRoot: '/old', state: 'ready' }, results: [], problems: [] },
    ] as never,
  });
  await flush();
  assert.equal(controller.store.getSnapshot().orphans.items, null);
});

test('a rejected refresh reports the failure and releases the controls', async () => {
  const { controller } = controllerFixture({
    maintenance: (command) =>
      command.type === 'list'
        ? Promise.reject(new Error('fixture IPC rejected'))
        : Promise.resolve({ ok: true, workspace: '/one', items: [] }),
  });
  controller.update(snapshot('/one'));
  await controller.refreshOrphans();
  const state = controller.store.getSnapshot();
  assert.equal(state.orphans.failure?.error, 'fixture IPC rejected');
  assert.equal(state.orphans.pending, false);
});

test('a streaming run disables the destructive actions', async () => {
  const { controller, maintenanceCalls } = controllerFixture({
    maintenance: async () => ({ ok: true, workspace: '/one', items: [] }),
  });
  controller.update(snapshot('/one', { running: true }));
  controller.act('binding-1', 'archive');
  await flush();
  assert.deepEqual(maintenanceCalls, []);
  assert.equal(controller.store.getSnapshot().blocked, true);
});

test('removing a retained workspace asks once before sending anything', async () => {
  const { controller, maintenanceCalls } = controllerFixture({
    maintenance: async () => ({ ok: true, workspace: '/one', items: [] }),
  });
  controller.update(snapshot('/one'));
  controller.act('binding-1', 'remove');
  await flush();
  assert.deepEqual(maintenanceCalls, []);
  assert.equal(controller.store.getSnapshot().orphans.confirmation, 'binding-1');
  controller.act('binding-1', 'remove');
  await flush();
  assert.deepEqual(maintenanceCalls, [{ type: 'remove', bindingId: 'binding-1' }]);
  assert.equal(controller.store.getSnapshot().orphans.confirmation, null);
});

test('the archived list ignores a reply from another project', async () => {
  const { controller } = controllerFixture({
    archived: async () => archivedReply('/somewhere-else', [{ id: 'stale' }]),
  });
  controller.update(snapshot('/one'));
  await controller.refreshArchived();
  assert.equal(controller.store.getSnapshot().archived.items, null);
});

test('deleting an archived session asks once, then sends the carrier command and reloads', async () => {
  const { controller, selectCalls } = controllerFixture({
    archived: async () => archivedReply('/one', [{ id: 'session-1', title: 'Keep' }]),
  });
  controller.update(snapshot('/one'));
  await controller.refreshArchived();
  controller.removeArchived('session-1');
  assert.equal(controller.store.getSnapshot().archived.confirmation, 'session-1');
  controller.removeArchived('session-1');
  await flush();
  await flush();
  assert.deepEqual(selectCalls, [{ type: 'deleteSession', id: 'session-1' }]);
});

test('a failed carrier action reports it and reloads the list', async () => {
  const { controller } = controllerFixture({
    archived: async () => archivedReply('/one', [{ id: 'session-1' }]),
    select: async () => null,
  });
  controller.update(snapshot('/one'));
  await controller.refreshArchived();
  controller.unarchive('session-1');
  await flush();
  await flush();
  assert.equal(controller.store.getSnapshot().archived.error, t('archived.failed'));
});

test('disposing stops a late reply from landing', async () => {
  let release: ((reply: ArchivedSessionsReply) => void) | undefined;
  const { controller } = controllerFixture({
    archived: () =>
      new Promise<ArchivedSessionsReply>((resolve) => {
        release = resolve;
      }),
  });
  controller.update(snapshot('/one'));
  const loading = controller.refreshArchived();
  controller.dispose();
  release?.(archivedReply('/one', [{ id: 'late' }]));
  await loading;
  assert.equal(controller.store.getSnapshot().archived.items, null);
});
