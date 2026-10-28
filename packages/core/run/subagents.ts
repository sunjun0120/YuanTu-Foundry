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
 * The built-in delegation path: how a child session comes into being and how one turn of it is run.
 *
 * The in-process provider is the closure that used to be the only way to delegate, now one named provider among
 * however many an embedder registers — so this module owns the *lifecycle* of a child: resolve its model before
 * anything durable is created, seed a forked transcript, record the assignment in the parent's log before the
 * session can be observed, then run one turn either through a residency (a child that outlives its turn) or
 * directly.
 *
 * Two rules are load-bearing here:
 *
 * - **The model is resolved before the session exists.** A host that cannot serve a requested model must refuse
 *   the task *without* leaving an empty child session behind for a crash-recovery pass to find and report.
 * - **The assignment is recorded before `started()`.** If the run dies mid-delegation the card is still
 *   recoverable from the parent's log, and a reader of that log never has to reach into the child's own session
 *   to know the child existed. The persona and model travel with the record, because a resume in another process
 *   has nothing else to rebuild them from.
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
  /**
   * The directory this child was given, when the run isolates its children.
   *
   * Carried into the turn builder rather than resolved there, because it is already a durable decision by the time
   * a turn exists: the manager allocated the directory and the store recorded which session owns it. A child whose
   * turns resolve their own root would be a second answer to a question that already has one.
   */
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
   * The workspace service, when this host isolates its children.
   *
   * The provider is where a binding becomes a fact about a session: it creates the child session, attaches it to
   * the directory the coordinator allocated, and records both in the parent's log before anybody can observe either.
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
 * The registry a run delegates through: the built-in in-process provider plus whatever the host registered.
 *
 * Built per run because a provider's capabilities are a promise about *this* host — `agentOptions` is advertised
 * only when a model can actually be resolved, so a host that cannot serve a requested model refuses the task
 * instead of quietly running it on the default one.
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
         * Always true here, and for the same reason `contextFork` is: this provider creates the child session
         * itself, so the directory the child works in is a decision this process makes rather than a promise about
         * somebody else's runtime. A provider that runs children elsewhere must *not* advertise this.
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
        /**
         * A forked child starts from this conversation.
         *
         * The copy happens before `started()`, so a consumer that reacts to the child's session the moment
         * it is announced never sees an empty one — and before the child's own prompt is appended, which
         * is what keeps the inherited history *behind* the task instead of after it. `forkSeed` decides
         * what fits and starts the copy at a user turn, so a trimmed transcript cannot begin with a tool
         * result whose call was dropped.
         */
        /**
         * A fork inherits the parent's *conversation*, not the runtime's own announcements. The skills
         * catalogue is machine-written context for the parent's workspace; copying it into a child would
         * spend the child's fork budget on text it does not need and count a machine note as a human turn.
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
         * The child is attached to its directory before anything can address it.
         *
         * `store.create` is what makes the session exist, and `attach` is what makes its directory usable; both
         * happen before `started()` and before the assignment is recorded, so a reader that reacts to the child the
         * moment it is announced can never find a session whose writes have nowhere to go. The store re-checks the
         * parent/child relationship inside that transaction, which is the ownership half of it: a binding cannot be
         * attached to a session that is not this delegator's own child.
         *
         * A *shared* binding is passed through rather than attached, and the distinction is real: the synthesized
         * binding of a session that predates isolation has no `preparing` row to finish and no directory this
         * service created, so asking the store to attach it would be asking it to complete an allocation that never
         * happened. The child simply executes in the delegator's directory, which is what the binding already says.
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
         * The persona this child speaks with: the one its delegation named, and nothing else.
         *
         * Computed once and used for the child's options, the slot it occupies *and* the durable record, so the
         * three cannot disagree. **Not** inherited from the parent: a persona is who is speaking, and a child
         * that inherited its parent's would shadow the deployment's persona while having been given none of its
         * own — which reads as "the persona feature silently does nothing" and is what an empty replacer does,
         * because declaring a replacement is what suppresses the section, not contributing to it.
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
           * The task carries the model, and not only the resolved provider.
           *
           * Those are two different statements. `childProvider` above is *where the request goes*; the task's
           * model is the identity the turn runs under — `createChildTurns` turns it into the child's
           * `modelInfo`, which stamps every user turn the child writes and is what a reader of its session
           * sees. The provider-facing `task` this closure was handed has no model by design (a task describes
           * the work; the model is a request option), so without this the model was dropped here and the
           * `modelInfo` override in `run/child-turns.ts` could never fire: a child delegated to another model
           * reached the right endpoint while its own transcript still named its parent's.
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
