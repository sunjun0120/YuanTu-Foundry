import { Ajv } from 'ajv';
import type { SubAgentRole, SubAgentSummaryReport } from '../../protocol/index.ts';
import type { WorkspaceMode } from '../../protocol/workspaces.ts';
import { resolveWorkspaceKind } from '../../workspaces/manager.ts';
import { redactSecrets } from '../../platform/redact.ts';
import type { SubAgentTask } from './providers.ts';
import type { AdmittedTask, SubAgentResult } from './delegation.ts';

/**
 * The delegation contract: the task and report schemas, their normalisation, the role and task prompts, and how
 * a child's result is rendered for its parent.
 *
 * Split out of `./delegation.ts`, which keeps the coordinator that schedules children. Everything here is a pure
 * function of its arguments or a constant, so it can be read, tested and changed without the scheduler.
 */
/**
 * How large a caller-supplied answer schema may be, serialised.
 *
 * It is not only a limit on the request: the whole schema is the child's tool definition, so every field
 * description in it is paid for on every round the child runs — a schema the caller is careless with is a bill
 * the child pays.
 */
export const MAX_TASK_SCHEMA_CHARS = 4_000;
export class SubAgentLimitError extends Error {}
/**
 * The task shape, shared by both delegation tools.
 *
 * Shared rather than copied because the two tools accept exactly the same tasks: a fork differs in where the
 * child starts, not in what may be asked of it, and two copies of a schema is how one of them would quietly
 * stop accepting a field the other still does.
 */
export function tasksSchema(
  maxFanout: number,
  providers: readonly string[],
): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    maxItems: maxFanout,
    items: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'What this sub-agent must find out or do, stated as one self-contained goal.',
        },
        role: {
          type: 'string',
          enum: ['explore', 'general'],
          description:
            'explore (default, read-only) or general (may write; each write still needs approval).',
        },
        context: {
          type: 'string',
          maxLength: 8000,
          description: 'Facts, file paths and constraints the sub-agent cannot rediscover cheaply.',
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Optional model id for this sub-agent. Call list_subagent_models first: a host that cannot serve the id refuses the task with UNSUPPORTED_CAPABILITY instead of silently using its default.',
        },
        /**
         * Offered only when this host actually has a choice, which is why it is built here rather than declared
         * as a constant field: a `provider` property on a host with one provider is an invitation to name
         * something that cannot exist, and the model would spend a round learning that.
         */
        ...(providers.length > 1
          ? {
              provider: {
                type: 'string',
                enum: [...providers],
                description:
                  'Optional: which implementation runs this sub-agent. Omit for the default. A name that is not in this list is refused, and so is a task asking this provider for something it does not declare — both before any child session exists.',
              },
            }
          : {}),
        persona: {
          type: 'string',
          minLength: 1,
          maxLength: 600,
          description:
            "Optional: the identity this sub-agent should speak with, which **replaces** the deployment's persona for this child alone rather than adding to it. Use it when the work needs a different voice — a security reviewer, a copy editor — not to change what the child may do: that is `role`, and no persona can grant a permission or lift a restriction. Keep it to an identity and a stance; instructions that contradict the deployment's rules are ignored in favour of those rules.",
        },
        schema: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional JSON Schema for the object this sub-agent must come back with, when the default report shape (summary, findings with evidence, unverified, blockers) is not what you want to read. It replaces that shape rather than extending it: the child submits through a tool whose argument schema is this one, so what arrives has already been validated against it, and the answer reaches you as that object. Keep it small and give each field a description — the child sees this schema and nothing else about the shape you want.',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  };
}
export function normalizeTasks(
  value: unknown,
  maxFanout: number,
  mode: WorkspaceMode,
): Omit<AdmittedTask, 'fork'>[] {
  if (!Array.isArray(value) || !value.length)
    throw new SubAgentLimitError('delegate_task needs at least one task');
  if (value.length > maxFanout)
    throw new SubAgentLimitError(`At most ${maxFanout} sub-agent tasks are accepted in one call`);
  return value.map((entry) => {
    const task = entry as Record<string, unknown>;
    const objective = typeof task.objective === 'string' ? task.objective.trim() : '';
    if (!objective)
      throw new SubAgentLimitError('Every sub-agent task needs a non-empty objective');
    if (objective.length > 2000) throw new SubAgentLimitError('Sub-agent objective is too long');
    const role = task.role === undefined ? 'explore' : task.role;
    if (role !== 'explore' && role !== 'general')
      throw new SubAgentLimitError('Sub-agent role must be explore or general');
    const context = typeof task.context === 'string' ? task.context.trim() : '';
    if (context.length > 8000) throw new SubAgentLimitError('Sub-agent context is too long');
    const model = typeof task.model === 'string' ? task.model.trim() : '';
    const provider = typeof task.provider === 'string' ? task.provider.trim() : '';
    const persona = typeof task.persona === 'string' ? task.persona.trim() : '';
    return {
      role,
      objective,
      ...(context ? { context } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(persona ? { persona } : {}),
      ...(task.schema === undefined ? {} : { schema: answerSchema(task.schema) }),
      // `explore` is the default role, and it is read-only: under `auto` that means it shares the delegator's
      // directory, because a copy of the tree it cannot change would cost disk and buy no protection.
      workspaceMode: resolveWorkspaceKind(mode, role),
    };
  });
}
/**
 * The caller's answer shape, checked here rather than when the child runs.
 *
 * The contract this replaces is validated in two places already (Ajv at the tool boundary, `normalizeReport`
 * after it); a caller-supplied schema only gets the first, so the refusals that have to happen *before* a child
 * exists are the ones checked by hand: it must compile, it must describe an object, and it must be small. Getting
 * this wrong later would mean a child session created, a model paid, and the failure surfacing as a tool error
 * inside the child — the exact shape of failure the capability checks were moved early to avoid.
 */
function answerSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new SubAgentLimitError('A task `schema` must be a JSON Schema object');
  const schema = value as Record<string, unknown>;
  if (schema.type !== 'object')
    throw new SubAgentLimitError('A task `schema` must describe an object (`"type": "object"`)');
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || !Object.keys(properties).length)
    throw new SubAgentLimitError(
      'A task `schema` needs at least one property for the child to fill in',
    );
  const encoded = JSON.stringify(schema).length;
  if (encoded > MAX_TASK_SCHEMA_CHARS)
    throw new SubAgentLimitError(
      `A task \`schema\` must be under ${MAX_TASK_SCHEMA_CHARS} characters when serialised (this one is ${encoded}); every field description in it is sent to the child on every round`,
    );
  try {
    new Ajv({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    throw new SubAgentLimitError(
      `A task \`schema\` must be a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return schema;
}

/**
 * What a child is told about itself. The role matters to the model: an `explore` child that does not
 * know it is read-only spends rounds discovering that its write tools do not exist.
 */
export function subAgentRolePrompt(role: SubAgentRole): string {
  const shared =
    'You are a sub-agent delegated by a parent agent. Your transcript is private to you: the parent sees only the final report you write, so state findings explicitly instead of referring to "the file above". ' +
    'You cannot ask the parent questions and you cannot delegate further. The user is not following your work: ask_user_question does reach them, so keep it for a decision you genuinely cannot make from the objective and the workspace, and otherwise work autonomously until you can answer the objective, then stop.';
  return role === 'explore'
    ? `${shared} You are read-only: tools that change the workspace or run commands are not available, and every permission-requiring operation is refused. Investigate, verify with evidence, and report what should change rather than changing it.`
    : `${shared} You may change the workspace and run commands, but every write, command and external operation still asks the user for permission, and a refusal is final. Your file changes are recorded against the parent session, so they stay visible and undoable there. Prefer the smallest change that satisfies the objective.`;
}
/**
 * The report schema, kept tight on purpose: the same object is stored in the run result, sent to the
 * parent as a tool result and shown in the desktop card, so its worst case is a real cost. The bounds
 * are enforced by Ajv when the tool is called, and re-applied by `normalizeReport` so nothing that
 * reaches the parent depends on the validator being configured as expected.
 */
export const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 1200,
      description: 'The answer to the objective, in one short paragraph.',
    },
    findings: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 300 },
          evidence: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description:
              'What you actually observed — a command and its result, or a file and its content. Write "not verified" rather than guessing.',
          },
          paths: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
        },
        required: ['statement', 'evidence'],
        additionalProperties: false,
      },
    },
    unverified: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 200 },
      description: 'Things you could not check, so the parent does not read them as findings.',
    },
    blockers: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};
export const SUBMIT_REPORT_DESCRIPTION =
  'Submit the final report and end this run. Every finding needs the evidence you actually observed; put anything you could not check in `unverified` instead of stating it as fact. Call this exactly once, when the objective is answered or you are blocked.';
function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function boundedList(value: unknown, items: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, items)
    .map((entry) => boundedText(entry, limit))
    .filter(Boolean);
}
/** Bounds a submitted report so the parent, the run row and the UI all receive the same shape. */
export function normalizeReport(value: Record<string, unknown>): SubAgentSummaryReport {
  const findings = Array.isArray(value.findings)
    ? value.findings
        .slice(0, 10)
        .map((entry) => entry as Record<string, unknown>)
        .map((entry) => ({
          statement: boundedText(entry.statement, 300),
          evidence: boundedText(entry.evidence, 300),
          ...(Array.isArray(entry.paths) && entry.paths.length
            ? { paths: boundedList(entry.paths, 4, 200) }
            : {}),
        }))
        .filter((entry) => entry.statement && entry.evidence)
    : [];
  if (!findings.length) throw new SubAgentLimitError('A report needs at least one finding');
  const summary = boundedText(value.summary, 1200);
  if (!summary) throw new SubAgentLimitError('A report needs a summary');
  const unverified = boundedList(value.unverified, 6, 200);
  const blockers = boundedList(value.blockers, 6, 200);
  return {
    summary,
    findings,
    ...(unverified.length ? { unverified } : {}),
    ...(blockers.length ? { blockers } : {}),
  };
}
/**
 * What a read-only sub-agent may use.
 *
 * The read-only filter already removes every mutating tool, so the entries this allowlist excludes *beyond*
 * that are excluded for a different reason: they manage resources the child cannot create and that belong to
 * its parent or its siblings. The job tools are the clearest case — a child's own registry carries the
 * literal `subagent` scope, shared by every resident child, so `job_list` / `job_output` would show a
 * sibling's command output and `job_kill` would stop it. `browser_close` closes the browser the parent may
 * have opened, `lsp_stop`/`lsp_servers` manage the parent's language server, and `discover_validations` only
 * exists to feed a validator the child cannot run. A read-only child must not be able to disturb — or read
 * past — the run it was delegated by.
 *
 * This is enforced as an allowlist on the child's registry rather than as a hint in the prompt, so a tool
 * that is not listed is not executable at all ("Unknown tool"), not merely hidden — which is why even tools
 * the read-only filter keeps have to be named here to be reachable. The current tool and schema sizes are
 * computed by `scripts/docs-facts.mjs` (`npm run docs:generate`), which the docs gate keeps honest.
 */
export const EXPLORE_TOOLS = [
  'read_file',
  'read_image',
  'list_files',
  'search_files',
  'repo_map',
  'git_status',
  'git_diff',
  'git_log',
  'git_branches',
  'git_worktrees',
  'lsp_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_symbols',
  'lsp_code_action',
  'lsp_workspace_symbols',
  'office_inspect',
  'verify_file_delivery',
  'recall_knowledge',
  'list_memories',
  // Asking the user is not an effect, so a read-only child may still ask one thing it cannot decide alone.
  'ask_user_question',
  // The checklist touches no workspace: it records what the child is doing in the child's own session, which
  // is exactly what a long investigation needs to stay legible.
  'todo_write',
  // A program is not an effect either: the tools it reaches are the ones listed above, and the catalog it is
  // handed is this child's own, so a research child that would otherwise spend eight rounds reading eight files
  // can spend one — with every read still going through the child's registry.
  'run_code',
  // Loading a schema grants nothing: `load_tools` asks this child's own registry, so it only loads names listed here.
  'load_tools',
] as const;
/**
 * A bounded, redacted one-line preview of tool arguments for the progress feed.
 *
 * The feed exists so the user can see what a child is doing without opening its transcript, and a bare
 * tool name does not achieve that ("read_file" of what?). It is truncated rather than streamed, and
 * redacted because the arguments of an external call can carry credentials.
 */
export function toolArgumentPreview(args: Record<string, unknown>, limit = 160): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** The child's only user turn: the objective, whatever context the parent could cheaply hand over, and the report contract. */
export function subAgentPrompt(task: SubAgentTask): string {
  return [
    'Delegated task from a parent agent.',
    `Objective: ${task.objective}`,
    ...(task.context ? [`Context supplied by the parent:\n${task.context}`] : []),
    'Finish by calling submit_report exactly once: a short summary, then findings that each pair a statement with the evidence you actually observed (a command and its result, or a file and its content), plus anything you could not verify. Do not restate your whole exploration, and never claim a command or test passed unless you ran it and saw the result. If you are blocked, submit what you have and say so in `blockers`.',
  ].join('\n\n');
}
/**
 * One block per task, in request order, so the parent can cite or distrust each one separately.
 *
 * Every block is bounded to an equal share rather than letting the first report consume the whole tool
 * output limit: with four sub-agents, a single long report would otherwise truncate the other three
 * out of existence, and the parent would never learn they ran.
 */
/**
 * The structured report as the parent reads it. A finding without its evidence would be exactly the
 * prose problem this format exists to fix, so both are always rendered together, and anything the
 * child could not verify is labelled instead of quietly promoted to a finding.
 */
export function renderFindings(report?: SubAgentSummaryReport): string[] {
  if (!report) return [];
  const lines = [`summary: ${report.summary}`, 'findings:'];
  for (const finding of report.findings) {
    const paths = finding.paths?.length ? ` [${finding.paths.join(', ')}]` : '';
    lines.push(`- ${finding.statement}\n  evidence: ${finding.evidence}${paths}`);
  }
  if (report.unverified?.length) lines.push(`unverified: ${report.unverified.join('; ')}`);
  if (report.blockers?.length) lines.push(`blockers: ${report.blockers.join('; ')}`);
  return lines;
}
/**
 * The object a caller-defined schema asked for, as the parent reads it.
 *
 * Printed as JSON because that is the shape the caller wrote down: pretty-printed (it is read by a model and by
 * a person looking at the transcript) and bounded by the same share as prose, since a schema cannot promise a
 * small answer and the parent's context is what pays for it.
 */
function renderAnswer(data: unknown, share: number): string {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    // A value that cannot be serialised should never reach here (it crossed a tool-call boundary to get in),
    // and if one ever does, saying so beats rendering nothing.
    text = '[the sub-agent’s answer could not be serialised]';
  }
  return text.length > share
    ? `result:\n${text.slice(0, share)}\n[answer truncated; the sub-agent session above holds the full transcript]`
    : `result:\n${text}`;
}
/**
 * How much of all the reports one `collect`/`delegate_task` call may put into the parent's context.
 *
 * Exported so the property can be asserted rather than described: the bound is what keeps a child's prose from
 * becoming the parent's budget, and a test in `tests/subagents.test.ts` pins it (a child that answers with sixty
 * thousand characters reaches the parent cut, and says so).
 */
/**
 * How much of a child's failure reaches the parent's tool result.
 *
 * The same 600 the durable `subagent.finished` record keeps (`agent.ts`, where the field is written), because the
 * two are read by different audiences for the same reason and a bound in one of them is not a bound: the log keeps
 * a summary of a failure, and the parent — which is a model spending its own context — must not be handed the
 * whole of an endpoint's error body. It is stated here rather than reached for from there so the two numbers can
 * be seen to be one decision.
 */
export const SUBAGENT_ERROR_CHARS = 600;
/** What a cut failure ends with, kept inside the bound so a later reader cannot cut the notice off. */
const ERROR_TRUNCATION_MARK = '…[truncated]';
/**
 * A child's failure as every reader gets it: at most `SUBAGENT_ERROR_CHARS`, and saying so when it was cut.
 *
 * The marker is inside the bound rather than appended after it because the durable record applies the same 600
 * again on its way to the log: a notice outside the limit would be trimmed off there, and the log would be the one
 * reader told least about what it was missing.
 */
export function boundedError(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= SUBAGENT_ERROR_CHARS) return text;
  return `${text.slice(0, SUBAGENT_ERROR_CHARS - ERROR_TRUNCATION_MARK.length)}${ERROR_TRUNCATION_MARK}`;
}
export const SUBAGENT_REPORT_CHARS = 24_000;
/** What a block keeps for its answer however much of its share the header took. */
const MIN_ANSWER_CHARS = 400;
const TRUNCATED_REPORT =
  '[report truncated; the sub-agent session above holds the full transcript]';
const OMITTED_PROSE = '[final prose omitted; it is in the sub-agent session]';
/** `text` within `budget` characters, the truncation notice included, so the notice cannot push it over. */
function fitted(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - TRUNCATED_REPORT.length - 1))}\n${TRUNCATED_REPORT}`;
}
export function report(
  results: readonly SubAgentResult[],
  tasks: readonly { objective: string }[],
): { content: string; isError: boolean } {
  const share = Math.max(1000, Math.floor((SUBAGENT_REPORT_CHARS - 400) / results.length));
  const blocks = results.map(({ summary, text: raw, seed, data }, index) => {
    const objective = tasks[index]?.objective ?? summary.objective;
    const lines = [
      `### Sub-agent ${index + 1}/${results.length} [${summary.role}] ${summary.status}`,
      `objective: ${objective}`,
      `session: ${summary.sessionId || 'none'} · rounds: ${summary.rounds} · tools: ${summary.toolCalls} · tokens: ${summary.usage.inputTokens} in / ${summary.usage.outputTokens} out`,
    ];
    // Only a forked child has this, and only a trimmed one needs the second half: a parent that is not told
    // the prefix was cut would assume the child saw everything it saw.
    if (seed)
      lines.push(
        `inherited context: ${seed.messages} message(s), ${seed.chars} characters` +
          (seed.dropped
            ? `; ${seed.dropped} message(s) were omitted to fit the fork budget or exclude an incomplete trailing tool batch`
            : ' (the whole conversation so far)'),
      );
    if (summary.error) lines.push(`error: ${summary.error}`);
    /**
     * The share bounds the whole block, not only the prose.
     *
     * A structured report is bounded by its schema, but that bound is per child and generous (a summary and ten
     * findings with evidence and paths), so rendering it outside the share let a few children put several times
     * `SUBAGENT_REPORT_CHARS` into the parent's context. The header, the findings and the prose come out of one
     * allowance, in that order: the findings are the part the parent can cite. A small floor keeps a long
     * objective from leaving nothing at all for the answer.
     */
    let budget = Math.max(MIN_ANSWER_CHARS, share - lines.join('\n').length);
    // A task that declared its own schema is answered in that shape, rendered as the object it is: the caller
    // defined the fields precisely so it would not have to read them out of prose.
    if (data !== undefined) lines.push(renderAnswer(data, budget));
    else {
      const findings = renderFindings(summary.report).join('\n');
      if (findings) {
        const kept = fitted(findings, budget);
        lines.push(kept);
        budget = Math.max(0, budget - kept.length - 1);
      }
      const text = raw.trim();
      if (text) lines.push(budget > TRUNCATED_REPORT.length ? fitted(text, budget) : OMITTED_PROSE);
      else if (!summary.report) lines.push('(the sub-agent produced no final report)');
    }
    return lines.filter((line) => line !== '').join('\n');
  });
  const failed = results.filter(({ summary }) => summary.status !== 'completed').length;
  return {
    content: blocks.join('\n\n'),
    // A partial failure still carries usable reports, so it is only a tool error when nothing worked.
    isError: results.length > 0 && failed === results.length,
  };
}
