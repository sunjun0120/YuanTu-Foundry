/**
 * The command vocabulary: the palette rows and the typed slash commands, as data.
 *
 * The menu and the typed form are one vocabulary, so they are defined once here. The two rules that used to live
 * inside the renderer and are easy to lose:
 *
 * - `/task` is the honest name for the draft command; `/goal` stays accepted for people who learned it;
 * - `/goal` and `/plan` without a description are refused with a sentence, not sent.
 *
 * `Export` carries the *active session id* and a suggested name; the Host pages through the whole conversation. The
 * visible message window is not the export source.
 */
import type { CarrierCommand } from '../../../../packages/carrier/contract.ts';
import type { SkillInfo } from '../../../../packages/protocol/skills.ts';
import { format, locale, t } from '../../i18n.ts';

export type PaletteItem =
  | { kind: 'command'; name: string; description: string; value: string }
  | { kind: 'skill'; name: string; description: string; value: string };

export type SlashOutcome = { command: CarrierCommand } | { error: string };

/** The window's own commands, in the order the palette shows them. */
export function commandItems(): PaletteItem[] {
  return [
    {
      kind: 'command',
      name: t('ui.compactContext'),
      description: t('command.compactDescription'),
      value: 'compact',
    },
    {
      kind: 'command',
      name: t('ui.exportSession'),
      description: t('command.exportDescription'),
      value: 'export',
    },
    {
      kind: 'command',
      name: t('ui.createGoal'),
      description: t('command.goalDescription'),
      value: 'task',
    },
    {
      kind: 'command',
      name: t('ui.createPlan'),
      description: t('command.planDescription'),
      value: 'plan',
    },
  ];
}

/** The text after a leading `/`, lowercased; `undefined` when the line is not a command query. */
export function commandQuery(text: string): string | undefined {
  const match = text.match(/^\/([^\s:]*)$/);
  return match?.[1]?.toLowerCase();
}

/**
 * Interface-language descriptions of the skills this build ships, by catalogue path. A built-in skill's own
 * description is written once, in the language its body uses; the menu speaks the interface's. A workspace skill
 * is shown as its author wrote it.
 */
export const BUILTIN_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'builtin:code-analysis-report': 'skill.codeAnalysisReportDescription',
  'builtin:office-documents': 'skill.officeDocumentsDescription',
};

export function paletteItems(
  text: string,
  dismissed: boolean,
  skills: readonly SkillInfo[] = [],
): PaletteItem[] {
  const query = commandQuery(text);
  if (query === undefined || dismissed) return [];
  const skillItems: PaletteItem[] = skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    description:
      skill.path in BUILTIN_SKILL_DESCRIPTIONS
        ? t(BUILTIN_SKILL_DESCRIPTIONS[skill.path]!)
        : skill.description,
    value: skill.name,
  }));
  return [...commandItems(), ...skillItems].filter((item) =>
    `${item.name} ${item.description} ${item.value}`.toLowerCase().includes(query),
  );
}

export interface ExportPayload {
  sessionId: string;
  suggestedName: string;
}

export function exportPayload(sessionId: string | null | undefined): ExportPayload | null {
  if (!sessionId) return null;
  return { sessionId, suggestedName: 'yuantu-session.md' };
}

/** The prompt value a chosen palette row leaves behind; `null` means "the row runs by itself" (export). */
export function promptForChoice(item: PaletteItem): string | null {
  if (item.kind === 'skill') return `/skill:${item.value} `;
  if (item.value === 'export') return null;
  return `/${item.value} `;
}

/**
 * What a submitted line asks for.
 *
 * `null` means an ordinary message (or a line with attachments, which are never treated as commands). The
 * composer clears the prompt when the answer is a command, matching the legacy flow.
 */
export function slashOutcome(
  text: string,
  hasAttachments: boolean,
  sessionId: string | null | undefined,
): SlashOutcome | null {
  if (hasAttachments) return null;
  const slash = text.match(/^\/(compact|export|goal|task|plan)(?:\s+([\s\S]*))?$/i);
  if (!slash) return null;
  const name = slash[1]!.toLowerCase();
  const argument = slash[2]?.trim() || '';
  const commandName = name === 'task' ? 'goal' : name;
  if ((commandName === 'goal' || commandName === 'plan') && !argument)
    return { error: format(t('ui.commandNeedsDescription'), { name }) };
  const command: CarrierCommand =
    name === 'compact'
      ? { type: 'compact' }
      : name === 'export'
        ? {
            type: 'export',
            ...(exportPayload(sessionId) ?? { content: '', suggestedName: 'yuantu-session.md' }),
          }
        : commandName === 'goal'
          ? { type: 'goal', prompt: argument, language: locale() }
          : { type: 'plan', prompt: argument, language: locale() };
  return { command };
}
export interface CommandPaletteState {
  text: string;
  skills: readonly SkillInfo[];
  selected: number;
  dismissed: boolean;
  disabled: boolean;
}

export interface CommandPaletteController {
  readonly store: import('../stores.ts').ReadableStore<CommandPaletteState>;
  /** A keystroke in the composer: reset the menu and filter for the new line. */
  onInput(): void;
  /** `true` when the palette consumed the key (arrows, Enter on a row, Escape). */
  onKeydown(event: KeyboardEvent): boolean;
  choose(item: PaletteItem): void;
  /** The composer's submit path asks this before treating the line as a message. */
  submitSlash(text: string, hasAttachments: boolean): SlashOutcome | null;
  update(input: { skills: readonly SkillInfo[]; disabled: boolean }): void;
  dispose(): void;
}
