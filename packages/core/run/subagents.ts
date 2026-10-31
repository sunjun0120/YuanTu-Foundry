import type { Provider, SubAgentRole, SubAgentTag } from '../../protocol/index.ts';
import type { WorkspaceBinding } from '../../protocol/workspaces.ts';
import { isRuntimeContext } from '../../protocol/context.ts';
import type { SessionStore, Session } from '../../storage/sqlite.ts';
import { isDurableBinding } from '../../storage/session-workspaces.ts';
import type { WorkspaceManager } from '../../workspaces/manager.ts';
import { nodeDependencyWarning } from '../../workspaces/dependencies.ts';
import { RUN_DEFAULTS } from '../../protocol/settings.ts';
import { forkSeed, seedReport } from '../subagents/fork.ts';
import { SubAgentProviderRegistry, inProcessProvider } from '../subagents/providers.ts';
import { subAgentPrompt } from '../subagents/delegation.ts';
import type {
  ResidentChildInput,
  ResidentTurnHandle,
  ResidentTurnResult,
  SubAgentResidency,
} from '../subagents/residency.ts';

/**
 * The built-in delegation path: creating a child session and running one turn of it.
 *
 * - The model is resolved before the session exists, so an unservable model leaves no empty child
 *   session.
 * - The assignment (with persona and model) is recorded in the parent's log before `started()`, so
 *   the card is recoverable and a resume elsewhere can rebuild the child.
 */

/** One turn of a child session, as the delegation block builds it: the same shape `Agent` builds in place. */
export type ChildTurns = (input: {
  task: { id: string; role: SubAgentRole; objective: string; model?: string };
  childSession: Session;
  depth: number;
  tag: SubAgentTag;
  childProvider?: Provider;
  childSignal?: AbortSignal;
  reportSchema?: Record<string, unknown>;
  persona?: string;
  /** The directory this child was given, already a durable decision by the time a turn exists. */
  binding?: WorkspaceBinding;
}) => {
  turn: (
    prompt: string,
    signal: AbortSignal,
    reportRequired: boolean,
    handle?: ResidentTurnHandle,
  ) => Promise<ResidentTurnResult>;
  close?: () => Promise<void>;
  /** Rebinds the emitter the next turn publishes through; see `ResidentChildInput.setEmit`. */
  setEmit?: (emit: import('./emit.ts').RunEmit) => void;
};

export interface InProcessProviderOptions {
  store: SessionStore;
  parentSessionId: string;
  workspace: string;
  runId: string;
  depth: number;
  residency?: SubAgentResidency | undefined;
  childTurns: ChildTurns;
  /**
   * The workspace service, when children are isolated. The provider attaches the child session to
   * its allocated directory and records both before anyone can observe them.
   */
  workspaceManager?: WorkspaceManager | undefined;
  /** Resolves the provider for a model a task asked for, or `undefined` when this host cannot serve it. */
  resolveProviderFor?: ((model: string) => Provider | undefined) | undefined;
  /** Characters of the parent transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptChars?: number | undefined;
  /** Messages of the parent transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptMessages?: number | undefined;
  /** Providers the host registered after the built-in one. */
  extraProviders?: readonly import('../subagents/providers.ts').SubAgentProvider[] | undefined;
}

/**
 * The registry a run delegates through: the built-in provider plus the host's. Per run because
 * `agentOptions` is advertised only when a child model can actually be resolved.
 */
export function createSubAgentProviders(
  options: InProcessProviderOptions,
): SubAgentProviderRegistry {
  const { store, parentSessionId, workspace, runId, depth, childTurns } = options;
  const providers = new SubAgentProviderRegistry();
  providers.register(
    inProcessProvider({
      capabilities: [
        'outputSchema',
        'depthLimit',
        'toolFilter',
        'persona',
        /**
         * Always true: this provider creates the child session, so the directory is its own
         * decision.
         */
        'workspaceIsolation',
        // Always true here: this provider creates the child session itself, so seeding it from the
        // parent's transcript is a local write rather than a promise about somebody else's runtime.
        'contextFork',
        ...(options.resolveProviderFor ? (['agentOptions'] as const) : []),
      ],
      run: async ({ task, options: childOptions, signal: childSignal, binding, started }) => {
        // Resolve the child's model *before* creating a session, so a model this host cannot serve
        // leaves no empty child session behind for a crash-recovery pass to find.
        const model = childOptions.agentOptions?.model;
        const childProvider = model ? options.resolveProviderFor?.(model) : undefined;
        if (model && !childProvider)
          throw new Error(
            `This host cannot run a sub-agent on model "${model}"; the task was not started`,
          );
        // A forked child starts from this conversation, copied before `started()` and before the
        // child's prompt. `forkSeed` decides what fits and starts at a user turn so no orphaned
        // tool result leads.
        /**
         * A fork inherits the conversation, not runtime announcements like the skills catalogue.
         */
        const seed = childOptions.contextFork
          ? forkSeed(
              store
                .messages(parentSessionId)
                .filter((message) => !isRuntimeContext(message.content)),
              {
                chars: options.forkTranscriptChars ?? RUN_DEFAULTS.forkTranscriptChars,
                messages: options.forkTranscriptMessages ?? RUN_DEFAULTS.forkTranscriptMessages,
              },
            )
          : undefined;
        const childSession = store.create(workspace, parentSessionId);
        /**
         * Attach the child to its directory before it is announced or recorded; the store re-checks
         * the parent/child relationship in the same transaction. A shared binding is passed
         * through, not attached: there is no allocation to complete.
         */
        const childBinding =
          binding && isDurableBinding(binding)
            ? (options.workspaceManager?.attach({
                bindingId: binding.id,
                childSessionId: childSession.id,
              }) ?? binding)
            : binding;
        const dependencyWarning =
          childBinding?.kind === 'worktree'
            ? await nodeDependencyWarning(childBinding.executionRoot, childSignal)
            : null;
        const prompt =
          subAgentPrompt(task) +
          (dependencyWarning
            ? `\n\nWorkspace dependency diagnostic (${dependencyWarning.code}): ${dependencyWarning.message}`
            : '');
        if (seed) for (const message of seed.messages) store.append(childSession.id, message);
        /**
         * The child's persona: only what its delegation named, never inherited. Used for the
         * options, the prompt slot and the durable record alike.
         */
        const childPersona = childOptions.persona;
        // Record the child in the parent's durable log *before* anyone can observe the session.
        store.recordEvent(parentSessionId, 'subagent.assigned', {
          runId,
          id: task.id,
          role: task.role,
          objective: task.objective,
          childSessionId: childSession.id,
          ...(childPersona ? { persona: childPersona } : {}),
          ...(model ? { model } : {}),
          // A forked child reads differently in the log: its transcript is not its own work.
          ...(seed ? { forked: true } : {}),
        });
        started(childSession.id);
        const tag: SubAgentTag = { id: task.id, role: task.role, objective: task.objective };
        const child = childTurns({
          /**
           * Carry the model on the task too: the provider is where the request goes, the model is
           * the identity (`modelInfo`) the child's transcript records.
           */
          task: { ...task, ...(model ? { model } : {}) },
          childSession,
          depth,
          tag,
          ...(childPersona ? { persona: childPersona } : {}),
          // The task's own schema, when it declared one: the fixed report contract needs no mention here.
          ...(task.schema ? { reportSchema: task.schema } : {}),
          ...(childProvider ? { childProvider } : {}),
          childSignal,
          ...(childBinding ? { binding: childBinding } : {}),
        });
        const settle = (outcome: ResidentTurnResult) => ({
          sessionId: childSession.id,
          status: outcome.status,
          text: outcome.text,
          ...(outcome.report ? { report: outcome.report } : {}),
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
          ...(seed ? { seeded: seedReport(seed) } : {}),
          rounds: outcome.rounds,
          toolCalls: outcome.toolCalls,
          usage: outcome.usage,
          ...(outcome.error ? { error: outcome.error } : {}),
        });
        if (options.residency) {
          const activation = options.residency.open({
            id: task.id,
            childSessionId: childSession.id,
            parentSessionId,
            objective: task.objective,
            depth,
            turn: child.turn,
            ...(child.close ? { close: child.close } : {}),
            ...(child.setEmit ? { setEmit: child.setEmit } : {}),
          } satisfies ResidentChildInput);
          return settle(await activation.run(prompt, true));
        }
        return settle(await child.turn(prompt, new AbortController().signal, true));
      },
    }),
  );
  for (const extra of options.extraProviders ?? []) providers.register(extra);
  return providers;
}
