import type { PreparedTool, Tool, ToolContext } from '../protocol/index.ts';
import { bounded } from './registry.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { WorkspaceFailure, workspaceDigest } from '../protocol/workspaces.ts';
import type { WorkspaceApply } from '../workspaces/results.ts';

/**
 * The two tools a *coordination parent* uses to take delivery of a child's work.
 *
 * `workspace_results` is read-only and lists what the parent has not imported; `workspace_result_apply` writes, and
 * therefore goes through the same prepare/approval/execute pipeline as every other write in this runtime. That is not
 * a formality: the approval is the moment a person sees which paths would change and agrees, and the pipeline is
 * what makes the agreement binding — the preview the person read is the exact content the execute step re-verifies.
 *
 * Three rules the tools state rather than assume:
 *
 * - **The tool never decides where the bytes go.** The target is the calling session's own execution directory,
 *   resolved from the binding. A model cannot name a path, and therefore cannot import a child's work into somebody
 *   else's tree.
 * - **A conflict is an answer, not a failure.** The parent is told which paths changed underneath it and nothing is
 *   written; the model's next move is a decision, not a retry.
 * - **Applying twice is applying once.** The result id and its digest are the key, so a repeated call answers with
 *   the change that already happened.
 */
export interface WorkspaceToolOptions {
  store: SessionStore;
  /** The importing side: preview and apply. Absent on a host that does not manage workspaces at all. */
  results: WorkspaceApply;
  /** The session these tools belong to, which is also the only directory they may import into. */
  sessionId: string;
}

export function workspaceResultTools(options: WorkspaceToolOptions): Tool[] {
  const { store, results, sessionId } = options;
  return [
    {
      name: 'workspace_results',
      isConcurrencySafe: () => true,
      description:
        'List the results sub-agents produced in isolated workspaces, with their status and the paths each one changes. ' +
        'Call this before applying: a result marked `superseded` was replaced by a later turn of the same child, and one marked `unsupported` holds changes this version will not import (a binary file, a mode change, or something too large) — review the child’s directory for those instead. ' +
        'Each entry carries the exact `resultId` and `digest` that `workspace_result_apply` needs.',
      inputSchema: {
        type: 'object',
        properties: {
          includeApplied: {
            type: 'boolean',
            description:
              'Also list results already imported, with the change each one produced. Defaults to false: the useful answer is what is still outstanding.',
          },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const includeApplied = args.includeApplied === true;
          const all = store.workspaceResults(sessionId);
          const shown = includeApplied
            ? all
            : all.filter((result) => result.status !== 'applied' && result.status !== 'superseded');
          if (!shown.length)
            return {
              isError: false,
              content:
                all.length === 0
                  ? 'No sub-agent produced a workspace result in this session. A child that ran in a shared workspace changes your own files directly, and a read-only child never produces one.'
                  : all.every((result) => result.status === 'applied')
                    ? 'Every sub-agent result has already been imported. Pass includeApplied to list them anyway.'
                    : 'No current result is awaiting import. Earlier results were superseded by later work; they were not necessarily imported. Pass includeApplied to see their history.',
            };
          return {
            isError: false,
            content: bounded(
              shown
                .map((result) =>
                  [
                    `- ${result.id} [${result.status}] child ${result.childSessionId}`,
                    `  digest: ${result.digest}`,
                    `  paths: ${result.paths.length ? result.paths.slice(0, 20).join(', ') : '(none offered for import)'}`,
                    ...(result.status === 'unsupported'
                      ? [
                          '  Automatic import is unsupported. Review the child’s directory; its work has not been imported.',
                        ]
                      : result.status === 'applying'
                        ? [
                            '  Import is in progress or awaiting recovery. Do not start another import.',
                          ]
                        : []),
                  ].join('\n'),
                )
                .join('\n'),
            ),
          };
        } catch (error) {
          return failureOf(error);
        }
      },
    },
    {
      name: 'workspace_result_apply',
      permission: 'write',
      description:
        'Import one sub-agent result into this session’s own directory. The approval shows every path that would change and the exact diff, so read it before agreeing. ' +
        'All paths are checked first: if any file changed since the result was frozen the whole import is refused as a conflict and nothing is written — resolve it in the other session and take a new result rather than retrying. ' +
        'Applying the same resultId and digest twice writes once; the second call returns the change that already happened.',
      inputSchema: {
        type: 'object',
        properties: {
          resultId: { type: 'string', minLength: 1, maxLength: 200 },
          expectedDigest: {
            type: 'string',
            minLength: 32,
            maxLength: 128,
            description:
              'The digest reported by workspace_results. It pins the exact content being applied: a result that changed since you read it is refused rather than applied.',
          },
        },
        required: ['resultId', 'expectedDigest'],
        additionalProperties: false,
      },
      prepare: (args, context) => prepareApply(args, context),
      execute: async (args, context) => (await prepareApply(args, context)).execute(context),
    },
  ];

  /**
   * The approval is built from a *read-only* preview, and the execute step re-verifies the same content.
   *
   * The two halves are what make an approval mean something here. `prepare` writes nothing — no file, no journal
   * entry — so a person can look at a preview and say no at no cost; `execute` re-derives the digest and re-checks
   * every target file, so an approval cannot be spent on bytes that changed after it was given. A conflict is
   * reported as a *result* rather than thrown, because "somebody edited this file" is information the model has to
   * act on, not an error to retry.
   */
  async function prepareApply(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<PreparedTool> {
    const resultId = String(args.resultId ?? '').trim();
    const expectedDigest = workspaceDigest(String(args.expectedDigest ?? '').trim(), 'digest');
    const preview = await results.previewApply({
      parentSessionId: sessionId,
      resultId,
      expectedDigest,
      signal: context.signal,
    });
    if (preview.conflicts.length)
      return {
        approvalDescription: `Sub-agent result ${resultId} conflicts with ${preview.conflicts.length} file(s) that changed since it was frozen: ${preview.conflicts.slice(0, 10).join(', ')}. Nothing will be written.`,
        async execute() {
          return {
            isError: false,
            content: [
              `Nothing was imported: ${preview.conflicts.length} file(s) changed in this workspace since result ${resultId} was frozen.`,
              `Conflicting paths: ${preview.conflicts.join(', ')}`,
              'No file was modified. Decide what the right content is — either keep your version and drop the result, or ask that child to work from your current files and produce a new result. Do not retry this call: the result is frozen against the bytes it was built from.',
            ].join('\n'),
          };
        },
      };
    return {
      approvalDescription: preview.description,
      change: preview.change,
      async execute(executeContext: ToolContext) {
        executeContext.signal.throwIfAborted();
        try {
          const outcome = await results.apply({
            parentSessionId: sessionId,
            resultId,
            expectedDigest,
            signal: executeContext.signal,
            context: executeContext,
          });
          if (outcome.status === 'conflict')
            return {
              isError: false,
              content: [
                `Nothing was imported: ${outcome.conflicts.length} file(s) changed in this workspace between the preview and this call.`,
                `Conflicting paths: ${outcome.conflicts.join(', ')}`,
                'No file was modified by this call.',
              ].join('\n'),
            };
          return {
            isError: false,
            content: [
              `Imported sub-agent result ${resultId} into this workspace.`,
              preview.change.path,
              ...preview.files.map((file) => `- ${file.path}`),
              'The change is in this session’s file-change list, so it can be undone like any other write. The child’s workspace is untouched: it still holds the work it produced.',
            ].join('\n'),
          };
        } catch (error) {
          return failureOf(error);
        }
      },
    };
  }
}

/** A workspace refusal reads as its own sentence, with the code the caller branches on at the end. */
function failureOf(error: unknown): { isError: boolean; content: string } {
  const message =
    error instanceof WorkspaceFailure
      ? `${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: bounded(message) };
}
