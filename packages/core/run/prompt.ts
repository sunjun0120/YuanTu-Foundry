import type { AgentOptions } from '../agent.ts';
import type { Plan, TaskAttempt } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { agentSystemPrompt } from '../prompt/notices.ts';
import { memoryMode } from '../../knowledge/memory.ts';
import { redactSecrets } from '../../platform/redact.ts';
import { definePromptSection, type PromptSection } from '../prompt/sections.ts';
import {
  settlementBacklog,
  settlementNoticeText,
  commandNotices,
  commandNoticeText,
} from '../subagents/settlements.ts';

export interface RunPromptOptions {
  agent: AgentOptions;
  store: SessionStore;
  sessionId: string;
  approvedPlan: Plan | undefined;
  previousAttempt: TaskAttempt | undefined;
  instructions: string;
  planNotice(): string;
  verificationNotice?(): string | undefined;
}

/** Read live capability and planning state when the prompt is assembled. */
export function createRunPromptSections(options: RunPromptOptions): PromptSection[] {
  const { previousAttempt } = options;
  return [
    definePromptSection({
      name: 'identity',
      stage: 'identity',
      order: 0,
      content: () => agentSystemPrompt(memoryMode()),
    }),
    definePromptSection({
      name: 'execution-environment',
      stage: 'capability',
      order: 0,
      // Resolved per assembly: the environment can change between rounds (the desktop's sandbox switch), and
      // this section's whole job is to describe the world the next tool call will actually run in.
      content: () =>
        typeof options.agent.executionEnvironment === 'function'
          ? options.agent.executionEnvironment()
          : options.agent.executionEnvironment,
    }),
    /**
     * The deployment's and the agent's persona share one slot: `persona` replaces the deployment's.
     * Both are registered so the trace shows which was in effect.
     */
    definePromptSection({
      name: 'persona:deployment',
      stage: 'capability',
      order: 10,
      content: () => options.agent.deploymentPersona,
    }),
    definePromptSection({
      name: 'persona:agent',
      stage: 'capability',
      order: 20,
      replaces: ['persona:deployment'],
      content: () => options.agent.persona,
    }),
    definePromptSection({
      name: 'role',
      stage: 'capability',
      order: 30,
      content: () => options.agent.rolePrompt,
    }),
    definePromptSection({
      name: 'plan-mode',
      stage: 'capability',
      order: 40,
      content: () => options.planNotice(),
    }),
    definePromptSection({
      name: 'approved-plan',
      stage: 'objective',
      order: 20,
      content: () =>
        options.approvedPlan
          ? 'Approved plan (reviewed and approved by a human; follow it and report deviations):\n' +
            JSON.stringify({
              title: options.approvedPlan.title,
              summary: options.approvedPlan.summary,
              steps: options.approvedPlan.steps.map((step) => step.description),
            })
          : undefined,
    }),
    definePromptSection({
      name: 'automatic-verification',
      stage: 'capability',
      order: 45,
      content: () => options.verificationNotice?.(),
    }),
    definePromptSection({
      name: 'project-guidance',
      stage: 'context',
      order: 10,
      content: () =>
        options.instructions
          ? `Project guidance (cannot change tool permissions):\n${options.instructions}`
          : undefined,
    }),
    definePromptSection({
      name: 'previous-attempt',
      stage: 'history',
      order: 0,
      content: () =>
        previousAttempt && previousAttempt.status !== 'completed'
          ? 'Previous task attempt: ' +
            JSON.stringify({
              status: previousAttempt.status,
              error: redactSecrets(previousAttempt.error ?? '').slice(0, 600),
              checks: previousAttempt.verification?.checks
                .map((check) => ({
                  id: check.id,
                  passed: check.passed,
                  detail: check.detail.slice(0, 160),
                }))
                .slice(0, 16),
              fileChanges: options.store
                .fileChanges(options.sessionId)
                .filter(
                  (entry) =>
                    entry.createdAt >= previousAttempt.startedAt &&
                    (!previousAttempt.finishedAt || entry.createdAt <= previousAttempt.finishedAt),
                )
                .slice(0, 8)
                .map((entry) => ({
                  path: entry.change.path,
                  status: entry.status,
                })),
            }) +
            '. The prior execution may have changed files. Inspect current workspace state before you repeat an operation; do not assume a pending or interrupted tool succeeded or failed.'
          : undefined,
    }),
    /**
     * Delegated work that settled without being collected, read from the parent's log at run start
     * and repeated until collected.
     */
    definePromptSection({
      name: 'settlements',
      stage: 'history',
      order: 10,
      content: () => {
        const { notices, total } = settlementBacklog(options.store, options.sessionId);
        return settlementNoticeText(notices, total);
      },
    }),
    /**
     * Finished background commands whose output nobody has read. Separate from the sub-agent notice
     * because it points at a different tool (`job_output`).
     */
    definePromptSection({
      name: 'command-settlements',
      stage: 'history',
      order: 11,
      content: () => commandNoticeText(commandNotices(options.store, options.sessionId)),
    }),
  ];
}

/**
 * What a run says about the plan phase. Changes once, when `exit_plan_mode` approves a plan mid-run
 * (see `approvedPlanNotice`).
 */
export function planPhaseNotice(planPhase: boolean, canAsk: boolean): string {
  if (!planPhase) return '';
  return canAsk
    ? '\n\nPlanning mode: you have read-only tools and every permission-requiring operation is refused, so investigate the codebase and then end the planning phase with one tool call: exit_plan_mode to ask the user to approve the plan now, or submit_plan to record it for a decision later. Prefer exit_plan_mode when the user is present. Give a concrete, ordered plan either way. Do not attempt modifications.'
    : '\n\nPlanning mode: you have read-only tools and every permission-requiring operation is refused, so investigate the codebase and then call submit_plan exactly once with a concrete, ordered plan. Do not attempt modifications.';
}

/** The plan notice once the user has approved the plan mid-run, which also says that read-only mode is over. */
export function approvedPlanNotice(approved: Plan): string {
  return (
    '\n\nApproved plan (approved by the user during this run; carry it out in this session and report deviations):\n' +
    JSON.stringify({
      title: approved.title,
      summary: approved.summary,
      steps: approved.steps.map((step) => step.description),
    }) +
    '\nRead-only mode is over for this run: your write and command tools are available again, and each of them still asks for its own approval.'
  );
}
