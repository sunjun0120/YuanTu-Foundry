/**
 * The system prompt as named, ordered sections, so a new fragment's position is a number, every
 * line's source is traceable (`PromptTrace`), and overrides are explicit
 * (`PromptSection.replaces`). Shadowing works within a single assembly.
 */

/** Where a section belongs in the assembled prompt. Declared as a closed set so the order has one owner. */
export const PROMPT_STAGES = [
  /** Who the agent is: the deployment's own words. */
  'identity',
  /** What this run may do and where: execution environment, role, mode notices. */
  'capability',
  /** What it is being asked to do: the task, the approved plan, the goal. */
  'objective',
  /** What it should know: project guidance, memory, skills, the workspace outline. */
  'context',
  /** What happened before: the previous attempt, uncollected settlements. */
  'history',
] as const;

export type PromptStage = (typeof PROMPT_STAGES)[number];

/**
 * The stage order, which is also assembly order: identity first, history last. Order within a stage
 * comes from each section's `order`.
 */
export const PROMPT_STAGE_ORDER: Readonly<Record<PromptStage, number>> = Object.freeze({
  identity: 0,
  capability: 10,
  objective: 20,
  context: 30,
  history: 40,
});

/**
 * One section of the prompt. `content` is a function of run state, called once per assembly;
 * whitespace-only content drops the section. `replaces` names sections this one overrides, recorded
 * in the trace.
 */
export interface PromptSection {
  /** Stable identity, used in the trace and as the target of `replaces`. Unique per assembly. */
  readonly name: string;
  /** Which part of the prompt this is; decides the coarse position. */
  readonly stage: PromptStage;
  /** Position within the stage, ascending. Equal orders fall back to name order, so assembly is deterministic. */
  readonly order: number;
  /** The section's text for this assembly, or nothing to contribute. */
  readonly content: () => string | undefined;
  /** Names of sections this one overrides. */
  readonly replaces?: readonly string[];
}

/** What one assembly was made of: every section considered, and what became of it. */
export interface PromptTrace {
  readonly name: string;
  readonly stage: PromptStage;
  /** `included` contributed text; `empty` contributed none; `shadowed` was named by another section's `replaces`. */
  readonly outcome: 'included' | 'empty' | 'shadowed';
  /** Name of the section that shadowed this one, when `outcome` is `shadowed`. */
  readonly shadowedBy?: string;
  /** Characters this section contributed, before joining. Zero unless `included`. */
  readonly chars: number;
}

export interface PromptAssembly {
  /** The prompt text, sections joined by a blank line. */
  readonly text: string;
  /** Every section in the order it was assembled, with its outcome. */
  readonly trace: readonly PromptTrace[];
}

export function definePromptSection(section: PromptSection): PromptSection {
  return section;
}

/**
 * Assemble one prompt from its sections:
 *
 * 1. Only a section that contributes text can replace another; an empty one must not suppress what
 *    it names.
 * 2. Shadowing then wins; two sections claiming the same name throw.
 * 3. Empty sections are dropped.
 * 4. Order is total: stage, then `order`, then name, independent of registration sequence.
 */
export function assemblePrompt(sections: readonly PromptSection[]): PromptAssembly {
  const byName = new Map<string, PromptSection>();
  for (const section of sections) {
    if (byName.has(section.name))
      throw new Error(`Prompt section "${section.name}" is registered twice in one assembly`);
    byName.set(section.name, section);
  }
  /** Read content once per section, so shadowing and the kept text see the same state. */
  const content = new Map<string, string>();
  for (const section of sections) content.set(section.name, section.content()?.trim() ?? '');
  const contributes = (name: string): boolean => (content.get(name) ?? '').length > 0;

  const shadowedBy = new Map<string, string>();
  for (const section of sections) {
    /**
     * Rule 1: an empty section (e.g. `persona:agent` with no persona) must not suppress the one it
     * names.
     */
    if (!contributes(section.name)) continue;
    for (const target of section.replaces ?? []) {
      if (target === section.name)
        throw new Error(`Prompt section "${section.name}" cannot replace itself`);
      if (!byName.has(target))
        throw new Error(
          `Prompt section "${section.name}" replaces "${target}", which is not registered in this assembly`,
        );
      shadowedBy.set(target, section.name);
    }
  }

  const ordered = [...sections].sort(
    (a, b) =>
      PROMPT_STAGE_ORDER[a.stage] - PROMPT_STAGE_ORDER[b.stage] ||
      a.order - b.order ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const trace: PromptTrace[] = [];
  const kept: string[] = [];
  for (const section of ordered) {
    const shadowed = shadowedBy.get(section.name);
    if (shadowed !== undefined) {
      trace.push({
        name: section.name,
        stage: section.stage,
        outcome: 'shadowed',
        shadowedBy: shadowed,
        chars: 0,
      });
      continue;
    }
    const text = content.get(section.name) ?? '';
    if (!text) {
      trace.push({ name: section.name, stage: section.stage, outcome: 'empty', chars: 0 });
      continue;
    }
    kept.push(text);
    trace.push({
      name: section.name,
      stage: section.stage,
      outcome: 'included',
      chars: text.length,
    });
  }
  return { text: kept.join('\n\n'), trace };
}
