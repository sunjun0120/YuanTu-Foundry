import type { CompletionSpec, Plan, ToolCall } from '../protocol/index.ts';
import { COMPLETION_LIMITS } from '../protocol/index.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { normalizeCompletionSpec, planCompletionSpec } from './completion-contract.ts';
import type { RunCompletion } from './run-completion.ts';
import type { ToolObservation } from './tool-progress.ts';
import { snapshotCompletionInputs } from './completion-inputs.ts';
import { projectChangedPaths } from './work-evidence.ts';

export const AUTOMATIC_VERIFICATION_GUIDANCE =
  'For implementation work, inspect the request, project guidance and existing build/test scripts, then call verify_work with relevant verification commands and source inputs. Commands use an executable and a separate args array, not a shell command line. The runtime runs these checks after your work and feeds assertion failures back for bounded repair. Register checks before editing when possible. Once registered, checks cannot be replaced to make a failure pass. Preserve approved plan steps and record their progress with completion_step. For UI work also inspect the running result when tools permit. Pure questions need no verification. If a meaningful check cannot run, explain the limitation; never claim verification without evidence.';

/** Agent-selected commands use the same verifier, approval seam and repair budget as explicit contracts. */
export function createAutomaticVerification(options: {
  enabled: boolean;
  objective: string;
  isReadOnly(): boolean;
  plan?: Plan;
  tools: ToolRegistry;
  completion: RunCompletion;
  workspace: string;
  signal: AbortSignal;
  runtimeStatePaths: readonly string[];
  /**
   * Told once, when the run first observes a substantive workspace change.
   *
   * Separate from `enabled`: an ordinary run that never registered checks still makes earlier evidence stale,
   * and this is the only place that sees the tool results which say so. The observer must not throw through
   * here — invalidation is bookkeeping, not part of the tool's result.
   */
  onChange?: () => void;
}) {
  const { completion, tools } = options;
  let plan = options.plan;
  let changed = false;
  let changeNotified = false;
  let reminded = false;
  let registered = false;
  let toolsChanged = false;
  let commandsPending = false;
  let baselineAttempted = false;
  let baseline: string | undefined;
  let observationUnknown = false;
  let observationError: string | undefined;
  const enabled = options.enabled && !completion.state.contractId;
  const objective =
    options.objective.trim().slice(0, COMPLETION_LIMITS.objectiveChars) || 'Complete the request';
  async function fingerprint(): Promise<string | undefined> {
    try {
      return (
        await snapshotCompletionInputs(options.workspace, ['.'], options.signal, {
          runtimeStatePaths: options.runtimeStatePaths,
        })
      ).digest;
    } catch (error) {
      options.signal.throwIfAborted();
      // An incomplete scan cannot establish that a shell command left the project unchanged.
      observationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
  async function assessChanges(): Promise<void> {
    if (options.isReadOnly() || completion.state.contractId || !commandsPending || changed) return;
    const current = await fingerprint();
    observationUnknown = baseline === undefined || current === undefined;
    changed = !observationUnknown && current !== baseline;
    commandsPending = false;
    if (changed && !changeNotified) {
      changeNotified = true;
      options.onChange?.();
    }
  }
  function spec(commands: unknown[], inputs: unknown): CompletionSpec {
    const acceptance = commands.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid verification command');
      const command = raw as Record<string, unknown>;
      return {
        description:
          typeof command.description === 'string' ? command.description : command.command,
        met: false,
        check: { ...command, id: `auto-${index + 1}`, kind: 'command' },
      };
    });
    const normalized = normalizeCompletionSpec({
      version: 1,
      objective,
      acceptance,
      inputs: inputs ?? [],
    });
    return plan
      ? planCompletionSpec(plan, { acceptance: normalized.acceptance, inputs: normalized.inputs })
      : normalized;
  }
  function register(approved?: Plan): void {
    if (approved) plan = approved;
    if (!enabled || registered || options.isReadOnly()) return;
    registered = true;
    completion.registerTools(true);
    tools.replace({
      name: 'verify_work',
      description:
        'Register the checks that verify this request. Inspect the request and repository guidance/scripts, then select relevant tests, builds or validation scripts. Supply an executable and separate args, not a shell command line. These commands run automatically when you finish; failures feed the same run for bounded repair. Registration grants no permission and does not execute commands. Checks cannot be replaced once registered. Call completion_step for approved plan steps after registration.',
      inputSchema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              properties: {
                command: { type: 'string', minLength: 1, maxLength: 4096 },
                args: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 16000 } },
                cwd: { type: 'string', maxLength: 4096 },
                timeoutMs: { type: 'integer', minimum: 10, maximum: 300000 },
                description: { type: 'string', maxLength: 500 },
              },
              required: ['command'],
              additionalProperties: false,
            },
          },
          inputs: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 4096 } },
        },
        required: ['commands'],
        additionalProperties: false,
      },
      async execute(args, context) {
        context.signal.throwIfAborted();
        if (options.isReadOnly())
          return {
            isError: true,
            content: 'Verification registration is unavailable in read-only or planning mode.',
          };
        if (completion.state.contractId)
          return {
            isError: true,
            content:
              'Verification checks are already registered and cannot be replaced. Repair the work or report the blocker.',
          };
        try {
          completion.configureAutomatic(spec(args.commands as unknown[], args.inputs), plan);
          toolsChanged = true;
          return {
            isError: false,
            content:
              'Verification checks registered. They will run automatically when you finish. Complete the work, record approved plan steps with completion_step, then report the result. Failed checks will be returned for repair.',
          };
        } catch (error) {
          return { isError: true, content: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  }
  return {
    register,
    assessChanges,
    get reviewError(): string | undefined {
      return observationUnknown && !changed
        ? `Workspace change detection was unavailable after command execution; verification remains unknown. ${observationError ?? ''}`
        : undefined;
    },
    get hasProjectWork(): boolean {
      return changed || plan !== undefined;
    },
    async beforeTools(calls: readonly ToolCall[]): Promise<void> {
      if (options.isReadOnly() || completion.state.contractId || changed || baselineAttempted)
        return;
      if (
        !calls.some((call) =>
          ['run_code', 'run_command', 'start_command', 'terminal_send', 'run_validation'].includes(
            call.name,
          ),
        )
      )
        return;
      baselineAttempted = true;
      baseline = await fingerprint();
    },
    takeToolsChanged(): boolean {
      const changed = toolsChanged;
      toolsChanged = false;
      return changed;
    },
    get guidance(): string | undefined {
      return enabled && !options.isReadOnly() ? AUTOMATIC_VERIFICATION_GUIDANCE : undefined;
    },
    observe(observations: readonly ToolObservation[]): void {
      for (const { call, result } of observations) {
        // Inner run_code calls appear separately in observations, so program-based edits are covered too.
        const paths = result.change ? projectChangedPaths(result.change, options.workspace) : [];
        if (paths.length && !changeNotified) {
          changeNotified = true;
          // Reported even when this run carries no contract: an ordinary turn that edits the workspace makes
          // the session's previous `verified` verdict describe a tree that no longer exists.
          options.onChange?.();
        }
        if (paths.length) changed = true;
        if (
          result.commandExecuted ||
          ((!result.isError || result.output?.render === 'command-output') &&
            ['run_command', 'start_command', 'terminal_send', 'run_validation'].includes(call.name))
        )
          commandsPending = true;
        if (enabled && result.change)
          for (const file of paths) {
            if (!completion.state.affectedPaths.includes(file))
              completion.state.affectedPaths.push(file);
          }
      }
    },
    /**
     * Whether the answer about to be requested would be replaced by a verification nudge.
     *
     * Read before the request so the answer can be persisted as `provisional` without a second write. It is the
     * same condition `beforeAnswer` uses for its first reminder; reading it does not consume the reminder.
     */
    willNudge(): boolean {
      return (
        enabled &&
        !options.isReadOnly() &&
        !completion.state.contractId &&
        (changed || plan !== undefined) &&
        !reminded
      );
    },
    async beforeAnswer(): Promise<'continue' | 'review' | undefined> {
      if (enabled) await assessChanges();
      if (
        enabled &&
        !options.isReadOnly() &&
        !completion.state.contractId &&
        observationUnknown &&
        !changed &&
        !plan
      ) {
        completion.configureAutomatic(spec([], []));
        completion.state.summary = {
          version: 1,
          state: 'unverified',
          reason: 'environment-error',
          contractId: completion.state.contractId,
          definitionHash: completion.state.contractDefinitionHash,
          verificationRound: 0,
          repairRounds: 0,
          repeatedFailures: 0,
          failedCheckIds: [],
          unfinishedStepIds: [],
        };
        return 'review';
      }
      if (!enabled || options.isReadOnly() || completion.state.contractId || (!changed && !plan))
        return;
      if (!reminded) {
        reminded = true;
        return 'continue';
      }
      completion.configureAutomatic(spec([], []), plan);
      completion.state.summary = {
        version: 1,
        state: 'unverified',
        reason: 'missing-verification',
        contractId: completion.state.contractId,
        definitionHash: completion.state.contractDefinitionHash,
        verificationRound: 0,
        repairRounds: 0,
        repeatedFailures: 0,
        failedCheckIds: [],
        unfinishedStepIds: [],
      };
      return 'review';
    },
  };
}
