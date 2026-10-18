import type { AgentHostClient } from '../client/host-client.ts';
import type { SessionController } from '../client/session-controller.ts';
import { initialTaskDraft, normalizeTaskDraft } from '../protocol/task-spec.ts';
import type { CarrierCommand, CarrierSnapshot } from './contract.ts';
import { CarrierError } from './errors.ts';

/**
 * The task and goal commands of `CarrierService.dispatch`.
 *
 * They run inside the service's dispatch — after its readiness, policy and busy checks, and before its refresh —
 * and see the service only through this context, so the state they may touch is the state named here.
 */
export interface TaskCommandContext {
  readonly client: AgentHostClient;
  readonly controller: SessionController;
  readonly tasks: CarrierSnapshot['tasks'];
  readonly configured: boolean;
  setTasks(tasks: CarrierSnapshot['tasks']): void;
  /** Marks a Host operation that must not overlap a restore; see the service's `restoring` flag. */
  setRestoring(restoring: boolean): void;
  reportError(error: CarrierError): void;
  safeError(error: unknown): string;
}

/**
 * The commands `runTaskCommand` answers. `goal` shares its command shape with `plan`, which the service runs itself
 * as plan mode, so that member is taken whole and narrowed by the switch.
 */
export type TaskCommand =
  | Extract<
      CarrierCommand,
      {
        type:
          | 'taskSave'
          | 'taskConfirm'
          | 'taskPropose'
          | 'taskStart'
          | 'taskApproval'
          | 'taskTrigger'
          | 'taskRefresh'
          | 'taskVerify'
          | 'taskRetry'
          | 'taskHistory';
      }
    >
  | Extract<CarrierCommand, { type: 'goal' | 'plan' }>;

function requireSession(context: TaskCommandContext): string {
  const sessionId = context.controller.sessionId;
  if (!sessionId) throw new CarrierError('sessionRequired');
  return sessionId;
}

export async function runTaskCommand(
  context: TaskCommandContext,
  command: TaskCommand,
): Promise<void> {
  const { client, controller } = context;
  switch (command.type) {
    case 'taskSave': {
      const sessionId = requireSession(context);
      await client.request('task.update', {
        sessionId,
        taskId: command.taskId,
        ...normalizeTaskDraft(command),
        expectedUpdatedAt: command.expectedUpdatedAt,
      });
      return;
    }
    case 'taskConfirm': {
      const sessionId = requireSession(context);
      await client.request('task.confirm', {
        sessionId,
        taskId: command.taskId,
        indices: command.indices,
        expectedUpdatedAt: command.expectedUpdatedAt,
      });
      return;
    }
    case 'taskPropose': {
      const sessionId = requireSession(context);
      try {
        await client.request('task.propose', { sessionId, taskId: command.taskId });
      } finally {
        await controller.load(sessionId);
      }
      return;
    }
    case 'taskStart': {
      const task = context.tasks.find((item) => item.id === command.taskId);
      if (!task) throw new CarrierError('taskNotFound');
      normalizeTaskDraft(task);
      await controller.send(task.description || task.title, undefined, task.id);
      return;
    }
    case 'taskApproval': {
      const sessionId = requireSession(context);
      await client.request('task.approval.respond', {
        sessionId,
        taskId: command.taskId,
        approvalId: command.approvalId,
        allow: command.allow,
      });
      return;
    }
    case 'taskTrigger': {
      const sessionId = requireSession(context);
      await client.request('task.trigger', {
        sessionId,
        taskId: command.taskId,
        trigger: command.trigger,
      });
      return;
    }
    // The full read at the end of `dispatch` is the refresh; reading here as well did every request twice.
    case 'taskRefresh':
      return;
    case 'taskVerify': {
      context.setRestoring(true);
      try {
        await client.request('task.verify', {
          sessionId: controller.sessionId!,
          taskId: command.taskId,
        });
      } finally {
        context.setRestoring(false);
      }
      return;
    }
    case 'taskRetry': {
      if (!controller.sessionId) throw new CarrierError('sessionRequired');
      const task = context.tasks.find((item) => item.id === command.taskId);
      if (!task) throw new CarrierError('taskNotFound');
      await controller.send(command.prompt?.trim() || task.description, undefined, task.id);
      return;
    }
    case 'taskHistory':
      return;
    case 'goal': {
      const sessionId = requireSession(context);
      const draft = initialTaskDraft(command.type, command.prompt, command.language);
      const task = await client.request('task.create', {
        sessionId,
        ...draft,
      });
      context.setTasks([task, ...context.tasks.filter((item) => item.id !== task.id)]);
      if (context.configured) {
        try {
          await client.request('task.propose', { sessionId, taskId: task.id });
        } catch (error) {
          context.reportError(
            new CarrierError('draftPlanningFailed', {
              message: context.safeError(error),
            }),
          );
        } finally {
          await controller.load(sessionId);
        }
      }
      return;
    }
  }
}
