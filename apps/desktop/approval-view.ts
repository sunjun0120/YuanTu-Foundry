import type { Approval } from '../../packages/protocol/index.ts';
import { format, t } from './i18n.ts';

/**
 * What the person is asked to allow, in their language and before any raw argument.
 *
 * The card used to lead with the Host's English description and the call's JSON: `Isolation: Runs under a
 * restricted Windows token…` above `{"command": …}`. Both are kept, folded under "full operation details", for
 * the reader who wants them; the card itself says what will happen, to what, and why it needs a yes.
 */
export interface ApprovalSummary {
  title: string;
  why: string;
  /** The one thing the call acts on — a command line, a URL, a query, some paths — when it names one. */
  subject?: string;
  directory?: string;
  /** The isolation sentence, for a command. */
  boundary?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string'))
    return value.join(' ');
  return undefined;
}
function subjectOf(args: Record<string, unknown>): string | undefined {
  const command = text(args.command);
  if (command) {
    const rest = text(args.args);
    return rest ? `${command} ${rest}` : command;
  }
  for (const key of ['input', 'url', 'query', 'paths', 'path', 'output_path', 'message', 'branch'])
    if (text(args[key])) return text(args[key]);
  return undefined;
}
export function boundaryText(boundary: NonNullable<Approval['boundary']>): string {
  return format(t('approval.boundary'), {
    files: t(`approval.files.${boundary.processFiles}`),
    network: t(`approval.network.${boundary.network}`),
  });
}
export function approvalSummary(approval: Approval): ApprovalSummary {
  const args = approval.toolCall.arguments ?? {};
  const tool = approval.toolCall.name;
  const directory = text(args.cwd);
  return {
    title: t(`approval.title.${approval.kind}`),
    why: format(t(`approval.why.${approval.kind}`), { tool }),
    ...(approval.change ? {} : { subject: subjectOf(args) }),
    ...(directory ? { directory } : {}),
    ...(approval.boundary ? { boundary: boundaryText(approval.boundary) } : {}),
  };
}
