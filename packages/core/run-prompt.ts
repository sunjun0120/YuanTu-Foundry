import type { AgentOptions } from './agent.ts';
import type { Plan, TaskAttempt } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { AGENT_SYSTEM_PROMPT } from './agent-notices.ts';
import { redactSecrets } from './errors.ts';
import { definePromptSection, type PromptSection } from './prompt-sections.ts';
import {
  settlementNoticeText,
  settlementNotices,
  commandNotices,
  commandNoticeText,
} from './settlements.ts';

export interface RunPromptOptions {
  agent: AgentOptions;
  store: SessionStore;
  sessionId: string;
  approvedPlan: Plan | undefined;
  previousAttempt: TaskAttempt | undefined;
  instructions: string;
  planNotice(): string;
}

/** Read live capability and planning state when the prompt is assembled. */
export function createRunPromptSections(options: RunPromptOptions): PromptSection[] {
  const { previousAttempt } = options;
  return [
    definePromptSection({
      name: 'identity',
      stage: 'identity',
      order: 0,
      content: () => AGENT_SYSTEM_PROMPT,
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
     * The deployment's persona and the agent's own, in one slot.
     *
     * `persona` is registered second and names the first as replaced, so the agent's paragraph wins and the
     * deployment's is dropped for this run. Both are registered even when only one is set, because "which
     * persona was in effect" is what the trace has to answer.
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
     * Work this session delegated and never heard back from.
     *
     * A sub-agent that settled after the turn that started it has nowhere else to reach its parent: the
     * tool result that would have carried its report belongs to a call the parent no longer makes, and the
     * coordinator that held it died with that run. The parent's own log is what is left, so this is read
     * from the log at the start of the run — which is exactly the moment a parent picking up "I delegated
     * this earlier" needs it. It repeats until the outcome is collected, because a notice that fires once
     * and is missed leaves the work unread, which is the state this exists to prevent.
     */
    definePromptSection({
      name: 'settlements',
      stage: 'history',
      order: 10,
      content: () => settlementNoticeText(settlementNotices(options.store, options.sessionId)),
    }),
    /**
     * A background command that finished and whose output nobody has read.
     *
     * The same gap as the sub-agent notice above and read the same way — from the session's log, at the start
     * of the run, repeating until the result is read — but it is its own section because it asks for a
     * different tool: a child's report is `collect_subagents`, a command's output is `job_output`. One
     * paragraph naming both would make the model choose between them by guessing.
     */
    definePromptSection({
      name: 'command-settlements',
      stage: 'history',
      order: 11,
      content: () => commandNoticeText(commandNotices(options.store, options.sessionId)),
    }),
  ];
}
