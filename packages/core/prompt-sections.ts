/**
 * The system prompt as **named, ordered sections** instead of one concatenation.
 *
 * The prompt a run sends (`composeSystem` in `packages/core/agent.ts`) was one expression of fourteen
 * `+`-joined fragments. That shape has three costs, and naming the sections is what removes them:
 *
 * 1. **Where does a new fragment go?** A tool's guidance, a mode's notice, a deployment's persona — each one had
 *    to be spliced into the middle of a 3,000-line file, and the only way to check the result was to run a model
 *    round and read the prompt that came out. A section carries its own `order`, so the answer is a number at the
 *    registration site.
 * 2. **Who wrote this line?** An assembled string cannot say which fragment produced which paragraph. A
 *    {@link PromptTrace} names every section, its position, and what it contributed, which is what makes "the
 *    prompt says something I did not expect" answerable without bisecting the code.
 * 3. **What can override what?** A child agent shares its parent's composition but must not inherit the parent's
 *    *role*: the role paragraph is exactly the part that has to differ, and today it is appended after the
 *    parent's rather than replacing it. {@link PromptSection.replaces} is that statement, and
 *    {@link PromptAssembly.shadowed} is the record that it happened.
 *
 * Scope here is one section shadowing another **within a single assembly**, which is what a delegated child
 * needs. It is deliberately not DSH's scoped service registry: that design lets a plugin register a section for
 * a whole agent subtree and have the nearest registration win, which is the right shape when composition is
 * owned by a plugin runtime rather than by the run. Adopting the shadowing *rule* now, and the registry that
 * would need it later, keeps this change reviewable and the prompt byte-identical.
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
 * The display order of the stages, which is also the assembly order.
 *
 * Identity first because a later stage may restate it ("you are read-only"); history last because a notice about
 * an earlier attempt reads as an aside rather than as the frame. The order of the stages is a decision; the order
 * *within* a stage is not — that is what `order` on each section is for.
 */
export const PROMPT_STAGE_ORDER: Readonly<Record<PromptStage, number>> = Object.freeze({
  identity: 0,
  capability: 10,
  objective: 20,
  context: 30,
  history: 40,
});

/**
 * One section of the prompt.
 *
 * `content` is returned rather than stored because every fragment here is a function of run state — whether the
 * run may write, which workspace it is in, what the previous attempt did. It is called once per assembly and its
 * result decides whether the section exists at all: whitespace-only content is dropped, which is how a fragment
 * that does not apply stops being an empty paragraph in the middle of the prompt.
 *
 * `replaces`, when given, names sections this one overrides. It is a claim rather than a mechanism: assembly
 * drops the named sections and records the replacement in the trace, so a shadowed section that turns out to
 * have been load-bearing is visible instead of silently gone.
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
 * Assemble one prompt from its sections.
 *
 * The rules, in the order they apply, because each one can hide a section from the next:
 *
 * 1. **Only a section that contributes text can replace another.** An empty section is *absent*, and an absent
 *    section must not suppress the one it names — otherwise the very act of registering a slot "so the trace can
 *    report it" would take the section away. This rule was added after that failure was observed rather than
 *    reasoned about: every agent with no persona of its own was silently losing its deployment's.
 * 2. **Shadowing then wins** for what a contributing replacement names, wherever it sits. Two sections claiming
 *    the same name is a programming error rather than a precedence puzzle, so it throws: with duplicates, "which
 *    one shadowed it" has no answer and the trace would be a lie.
 * 3. **Empty sections are dropped.** A fragment that returns nothing does not leave a blank line behind, which is
 *    what lets a caller register every section unconditionally and let the run state decide.
 * 4. **Order is total.** Stage order, then `order`, then name. Nothing depends on registration sequence, so moving
 *    a registration in the source cannot move the paragraph in the prompt.
 */
export function assemblePrompt(sections: readonly PromptSection[]): PromptAssembly {
  const byName = new Map<string, PromptSection>();
  for (const section of sections) {
    if (byName.has(section.name))
      throw new Error(`Prompt section "${section.name}" is registered twice in one assembly`);
    byName.set(section.name, section);
  }
  /**
   * Content is read once per section.
   *
   * A fragment is a function of run state — it may read the filesystem or the store — so calling it twice could
   * see two different states and make the shadowing decision disagree with the text that was kept.
   */
  const content = new Map<string, string>();
  for (const section of sections) content.set(section.name, section.content()?.trim() ?? '');
  const contributes = (name: string): boolean => (content.get(name) ?? '').length > 0;

  const shadowedBy = new Map<string, string>();
  for (const section of sections) {
    /**
     * Rule 1: only a section that contributes text can take another's place.
     *
     * A section that returns nothing is *absent*, and an absent section must not suppress the one it names. The
     * personas make this concrete: `persona:agent` is registered unconditionally so the trace can answer "which
     * persona was in effect", and if merely declaring the replacement were enough then every agent without a
     * persona of its own would silently lose its deployment's — a failure that shortens the prompt and says
     * nothing, which is the kind this project refuses.
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
