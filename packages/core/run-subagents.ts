import type { Provider, SubAgentRole, SubAgentTag } from '../protocol/index.ts';
import type { SessionStore, Session } from '../storage/sqlite.ts';
import { RUN_DEFAULTS } from '../protocol/settings.ts';
import { forkSeed, seedReport } from './fork.ts';
import { SubAgentProviderRegistry, inProcessProvider } from './subagent-providers.ts';
import { subAgentPrompt } from './subagents.ts';
import type {
  ResidentChildInput,
  ResidentTurnHandle,
  ResidentTurnResult,
  SubAgentResidency,
} from './residency.ts';

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
}) => {
  turn: (
    prompt: string,
    signal: AbortSignal,
    reportRequired: boolean,
    handle?: ResidentTurnHandle,
  ) => Promise<ResidentTurnResult>;
  close?: () => Promise<void>;
};

export interface InProcessProviderOptions {
  store: SessionStore;
  parentSessionId: string;
  workspace: string;
  runId: string;
  depth: number;
  residency?: SubAgentResidency | undefined;
  childTurns: ChildTurns;
  /** Resolves the provider for a model a task asked for, or `undefined` when this host cannot serve it. */
  resolveProviderFor?: ((model: string) => Provider | undefined) | undefined;
  /** Characters of the parent transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptChars?: number | undefined;
  /** Messages of the parent transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptMessages?: number | undefined;
  /** Providers the host registered after the built-in one. */
  extraProviders?: readonly import('./subagent-providers.ts').SubAgentProvider[] | undefined;
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
        // Always true here: this provider creates the child session itself, so seeding it from the
        // parent's transcript is a local write rather than a promise about somebody else's runtime.
        'contextFork',
        ...(options.resolveProviderFor ? (['agentOptions'] as const) : []),
      ],
      run: async ({ task, options: childOptions, signal: childSignal, started }) => {
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
        const seed = childOptions.contextFork
          ? forkSeed(store.messages(parentSessionId), {
              chars: options.forkTranscriptChars ?? RUN_DEFAULTS.forkTranscriptChars,
              messages: options.forkTranscriptMessages ?? RUN_DEFAULTS.forkTranscriptMessages,
            })
          : undefined;
        const childSession = store.create(workspace, parentSessionId);
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
          task,
          childSession,
          depth,
          tag,
          ...(childPersona ? { persona: childPersona } : {}),
          // The task's own schema, when it declared one: the fixed report contract needs no mention here.
          ...(task.schema ? { reportSchema: task.schema } : {}),
          ...(childProvider ? { childProvider } : {}),
          childSignal,
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
          } satisfies ResidentChildInput);
          return settle(await activation.run(subAgentPrompt(task), true));
        }
        return settle(await child.turn(subAgentPrompt(task), new AbortController().signal, true));
      },
    }),
  );
  for (const extra of options.extraProviders ?? []) providers.register(extra);
  return providers;
}
