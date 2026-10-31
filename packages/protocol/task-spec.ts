import type { Acceptance, AcceptanceCheck, TaskStep } from './index.ts';
import type { Language } from './language.ts';
import { COMPLETION_LIMITS } from './completion.ts';

const MAX_CHECKS = COMPLETION_LIMITS.acceptanceChecks;
export interface TaskDraft {
  title: string;
  description: string;
  steps: TaskStep[];
  acceptance: Acceptance[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid task definition');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, empty = false, trim = true): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes('\0')
  )
    throw new Error('Invalid task ' + name);
  return trim ? value.trim() : value;
}
/** Validate and normalize one executable acceptance check, enforcing id uniqueness. */
export function normalizeAcceptanceCheck(check: unknown, ids: Set<string>): AcceptanceCheck {
  const value = object(check);
  const id = text(value.id, 'check id', 128);
  if (ids.has(id)) throw new Error('Duplicate acceptance check id');
  ids.add(id);
  const kind = value.kind;
  if (kind === 'command') {
    const command = text(value.command, 'command', 4096);
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128))
      throw new Error('Invalid command arguments');
    const args = (value.args as unknown[] | undefined)?.map((x) =>
      text(x, 'argument', 16000, true, false),
    );
    if (
      value.expectedExitCode !== undefined &&
      (!Number.isSafeInteger(value.expectedExitCode) ||
        Math.abs(value.expectedExitCode as number) > 255)
    )
      throw new Error('Invalid expected exit code');
    if (
      value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutMs) ||
        (value.timeoutMs as number) < 1 ||
        (value.timeoutMs as number) > 300000)
    )
      throw new Error('Invalid check timeout');
    return {
      id,
      kind,
      command,
      ...(args ? { args } : {}),
      ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, 'working directory', 4096) }),
      ...(value.expectedExitCode === undefined
        ? {}
        : { expectedExitCode: value.expectedExitCode as number }),
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
    };
  }
  if (kind === 'file-exact' || kind === 'file-contains') {
    /**
     * Rebuild `maxBytes` like every other optional field, or an author's limit falls back to the 1
     * MB default.
     */
    if (
      value.maxBytes !== undefined &&
      (!Number.isSafeInteger(value.maxBytes) ||
        (value.maxBytes as number) < 1 ||
        (value.maxBytes as number) > 100_000_000)
    )
      throw new Error('Invalid acceptance maximum bytes');
    return {
      id,
      kind,
      path: text(value.path, 'path', 4096),
      expected: text(value.expected, 'expected content', 20000, true, false),
      ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes as number }),
    };
  }
  if (kind === 'file-delivery') {
    if (
      value.minBytes !== undefined &&
      (!Number.isSafeInteger(value.minBytes) ||
        (value.minBytes as number) < 1 ||
        (value.minBytes as number) > 100_000_000)
    )
      throw new Error('Invalid delivery minimum bytes');
    if (
      value.sha256 !== undefined &&
      (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256))
    )
      throw new Error('Invalid delivery SHA-256');
    if (
      value.format !== undefined &&
      ![
        'auto',
        'binary',
        'text',
        'pdf',
        'docx',
        'xlsx',
        'pptx',
        'xls',
        'png',
        'jpeg',
        'zip',
      ].includes(String(value.format))
    )
      throw new Error('Invalid delivery format');
    return {
      id,
      kind,
      path: text(value.path, 'path', 4096),
      ...(value.minBytes === undefined ? {} : { minBytes: value.minBytes as number }),
      ...(value.sha256 === undefined ? {} : { sha256: value.sha256 as string }),
      ...(value.format === undefined ? {} : { format: value.format as AcceptanceCheck['format'] }),
    };
  }
  if (kind === 'forbidden-path') {
    if (value.expectation !== 'absent' && value.expectation !== 'unchanged')
      throw new Error('Invalid forbidden path expectation');
    return {
      id,
      kind,
      path: text(value.path, 'path', 4096),
      expectation: value.expectation,
    };
  }
  throw new Error('Unsupported acceptance kind');
}
/** Validate a persisted acceptance list (empty allowed) including each executable check. */
export function validateAcceptance(input: unknown): Acceptance[] {
  // The verifier's own cap, so a stored task can always be verified.
  if (!Array.isArray(input) || input.length > MAX_CHECKS)
    throw new Error(`Invalid task acceptance: at most ${MAX_CHECKS} checks`);
  const ids = new Set<string>();
  return input.map((raw) => {
    const item = object(raw);
    if (typeof item.met !== 'boolean') throw new Error('Invalid task acceptance');
    return {
      description: text(item.description, 'acceptance', 2000),
      met: item.met,
      ...(item.check !== undefined ? { check: normalizeAcceptanceCheck(item.check, ids) } : {}),
    };
  });
}
export function normalizeTaskDraft(input: unknown): TaskDraft {
  const value = object(input);
  const title = text(value.title, 'title', 200);
  const description = text(value.description ?? '', 'description', 20000, true);
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 64)
    throw new Error('Provide 1–64 task steps');
  if (!Array.isArray(value.acceptance) || !value.acceptance.length || value.acceptance.length > 64)
    throw new Error('Provide 1–64 acceptance criteria');
  const steps: TaskStep[] = value.steps.map((raw) => ({
    description: text(object(raw).description, 'step', 2000),
    status: 'pending',
  }));
  const ids = new Set<string>();
  const acceptance: Acceptance[] = value.acceptance.map((raw) => {
    const item = object(raw);
    const result: Acceptance = {
      description: text(item.description, 'acceptance', 2000),
      met: false,
    };
    if (item.check !== undefined) result.check = normalizeAcceptanceCheck(item.check, ids);
    return result;
  });
  return { title, description, steps, acceptance };
}
/**
 * Default steps and acceptance line for a new draft, per language. Generated, not translated: they
 * are written into editable fields and never rendered through the dictionary. Chinese is the
 * fallback.
 */
const DRAFT_TEXT: Record<Language, { steps: readonly string[]; acceptance: string }> = {
  'zh-CN': {
    steps: ['检查相关文件，确认实现范围', '按照需求完成修改', '验证结果并报告证据'],
    acceptance: '人工检查结果符合任务需求',
  },
  'en-US': {
    steps: [
      'Check the relevant files and confirm the scope',
      'Make the change the request asks for',
      'Verify the result and report the evidence',
    ],
    acceptance: 'A person has checked that the result matches the request',
  },
};
export function initialTaskDraft(
  kind: 'goal' | 'plan',
  prompt: string,
  language: Language = 'zh-CN',
): TaskDraft {
  const text = DRAFT_TEXT[language] ?? DRAFT_TEXT['zh-CN'];
  return normalizeTaskDraft({
    title: (kind === 'goal' ? '' : 'Plan: ') + prompt.split(/\r?\n/, 1)[0]!.slice(0, 180),
    description: prompt,
    steps: text.steps.map((description) => ({ description })),
    acceptance: [{ description: text.acceptance, met: false }],
  });
}
