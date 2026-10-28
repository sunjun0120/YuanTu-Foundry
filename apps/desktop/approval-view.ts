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
  /** What is special about a project configuration file, when this edit touches one. */
  projectConfig?: string;
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
/**
 * Whether a path is a project-level configuration file.
 *
 * These are ordinary-looking edits with a different consequence: changing `package.json`'s scripts changes what
 * `npm test` means, and a CI file changes what runs on every push. In a real run the agent edited the test script
 * of the project just to make its own check pass, and the approval card showed it as "修改文件". The card now
 * says what is special about the file; the decision is still the person's.
 */
export function projectConfigKind(path: string | undefined): 'commands' | 'build' | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? '';
  if (name === 'package.json') return 'commands';
  if (/^(tsconfig|jsconfig)[^/]*\.json$/.test(name)) return 'build';
  if (/^(vite|vitest|jest|playwright|rollup|webpack|esbuild)\.config\.[cm]?[jt]s$/.test(name))
    return 'build';
  if (normalized.startsWith('.github/workflows/')) return 'build';
  if (name === 'dockerfile' || name === 'makefile') return 'build';
  return null;
}
export function approvalSummary(approval: Approval): ApprovalSummary {
  const args = approval.toolCall.arguments ?? {};
  const tool = approval.toolCall.name;
  const directory = text(args.cwd);
  const config = projectConfigKind(
    approval.change?.path ?? text(args.path) ?? text(args.output_path),
  );
  return {
    title: t(`approval.title.${approval.kind}`),
    why: format(t(`approval.why.${approval.kind}`), { tool }),
    ...(approval.change ? {} : { subject: subjectOf(args) }),
    ...(directory ? { directory } : {}),
    ...(approval.boundary
      ? {
          boundary: approval.escalation
            ? `${t('approval.escalation.network')}${boundaryText(approval.boundary)}`
            : boundaryText(approval.boundary),
        }
      : {}),
    ...(config ? { projectConfig: t(`approval.projectConfig.${config}`) } : {}),
  };
}
