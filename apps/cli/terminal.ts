import { createInterface } from 'node:readline/promises';
import type { PermissionPolicy } from '../../packages/core/permissions.ts';
import type {
  Approver,
  ApprovalDecisionSource,
  QuestionAnswer,
  Questioner,
  QuestionOutcome,
} from '../../packages/protocol/index.ts';
import type { Options } from '../shared/args.ts';
import { display } from '../shared/runtime.ts';

/** One-shot TTY question, used only for the plan approval gate. */
export async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
/**
 * Everything on standard input, for the one command that takes a secret.
 *
 * Reading the stream directly rather than asking a question: `credentials set` is meant to be usable as
 * `... | yuantu credentials set anthropic`, and a pipe has nobody to prompt. The bound is a sanity limit on a
 * value that is a few hundred characters at most, so a mistyped pipe (`cat bigfile | ...`) fails instead of
 * buffering.
 */
export async function readStandardInput(limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > limit) throw new Error('Standard input is larger than a credential can be');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The approval prompt: policy first, then launch options, then the terminal when there is one. */
export function createApprover(
  options: Options,
  permissionPolicy: PermissionPolicy | undefined,
): Approver {
  const approvalSources = new WeakMap<object, ApprovalDecisionSource>();
  const approve: Approver = async (approval, signal) => {
    signal.throwIfAborted();
    const decision = permissionPolicy?.decide(approval);
    if (decision === 'deny' || decision === 'allow') {
      approvalSources.set(approval.toolCall, 'policy');
      return decision === 'allow';
    }
    if (
      decision !== 'ask' &&
      ((approval.kind === 'write' && options.allowWrite) ||
        (approval.kind === 'command' && options.allowCommand && !approval.escalation))
    ) {
      approvalSources.set(approval.toolCall, 'launch-options');
      return true;
    }
    if (!process.stdin.isTTY || options.json) {
      approvalSources.set(approval.toolCall, 'unavailable');
      return false;
    }
    approvalSources.set(approval.toolCall, 'user');
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    // A sub-agent's approval would otherwise look exactly like the parent's own request, and the user
    // cannot tell whose work they are authorising.
    const attribution = approval.subagent
      ? `\n[subagent ${display(approval.subagent.role)}] ${display(approval.subagent.objective)}`
      : '';
    try {
      const answer = await terminal.question(
        `${attribution}\n${display(approval.description)}\nAllow this ${approval.kind === 'external' ? 'external service access' : approval.kind === 'command' ? 'host command' : 'file change'}? [y/N] `,
        { signal },
      );
      return answer.trim().toLowerCase() === 'y';
    } finally {
      terminal.close();
    }
  };
  approve.decisionSource = (approval) => approvalSources.get(approval.toolCall);
  return approve;
}

/**
 * Answering the model's structured question on the same terminal the approval prompt uses.
 *
 * A non-interactive invocation answers "unavailable" rather than blocking: `--json` is read by a program
 * and a piped stdin has nobody behind it, so waiting would hold the run open for an answer that cannot
 * come. The model is told the answer is missing and proceeds on a stated assumption, which is the same
 * outcome as a host with no questioner at all.
 */
export function createQuestioner(options: Options): Questioner {
  return async (request, signal): Promise<QuestionOutcome> => {
    signal.throwIfAborted();
    if (!process.stdin.isTTY || options.json)
      return { answered: false, answers: [], reason: 'unavailable' };
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      // A sub-agent's question would otherwise look like the parent's own, and the user cannot tell whose
      // work they are answering for.
      if (request.subagent)
        process.stderr.write(
          `\n[subagent ${display(request.subagent.role)}] ${display(request.subagent.objective)}\n`,
        );
      const answers: QuestionAnswer[] = [];
      for (const item of request.questions) {
        signal.throwIfAborted();
        const options_ = item.options ?? [];
        process.stderr.write(
          `\n${display(item.header ? `${item.header}: ` : '')}${display(item.question)}\n`,
        );
        options_.forEach((option, index) => {
          process.stderr.write(
            `  ${index + 1}) ${display(option.label)}${option.description ? ` — ${display(option.description)}` : ''}\n`,
          );
        });
        const hint = options_.length
          ? item.multiSelect
            ? 'Choose one or more numbers (comma separated), or type an answer: '
            : 'Choose a number, or type an answer: '
          : 'Answer: ';
        const raw = (await terminal.question(hint, { signal })).trim();
        const parts = raw
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        const selected: string[] = [];
        let freeText: string | undefined;
        // Digits are a selection; anything else is the answer itself, which is what makes a free-text
        // question and a numbered one the same prompt.
        if (options_.length && parts.length && parts.every((part) => /^\d+$/.test(part))) {
          for (const part of parts) {
            const option = options_[Number(part) - 1];
            if (option) selected.push(option.label);
          }
          if (!item.multiSelect && selected.length > 1) selected.length = 1;
        } else if (raw) freeText = raw;
        answers.push({
          id: item.id,
          selected,
          ...(freeText === undefined ? {} : { freeText }),
        });
      }
      return { answered: true, answers };
    } catch (error) {
      if (signal.aborted) return { answered: false, answers: [], reason: 'cancelled' };
      throw error;
    } finally {
      terminal.close();
    }
  };
}
