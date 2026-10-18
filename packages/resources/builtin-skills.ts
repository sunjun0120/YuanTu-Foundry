import type { SkillInfo } from '../protocol/skills.ts';

/**
 * Skills that ship with the application, so every workspace has them without copying files into it.
 *
 * They are text in the build rather than `SKILL.md` files beside it: a resource file would have to be copied
 * into each bundle (the desktop main process, the Host, the CLI) and found again at runtime, and a skill that
 * silently failed to load in one of them is worse than none. A workspace skill of the same name replaces the
 * built-in one, the same way `.yuantu/skills` replaces `.agents/skills`.
 */
export const BUILTIN_SKILL_PREFIX = 'builtin:';

const OFFICE_DOCUMENTS = `---
name: office-documents
description: Plan, write and check Word reports and PowerPoint decks with office_create, office_edit and office_preview.
---

# Writing Office documents

Use this when the user wants a report, proposal, letter, handout or slide deck as a .docx or .pptx file.

## Before writing

- Settle audience, purpose and length first. If the request leaves them open, choose sensible defaults and say
  which ones you chose instead of asking several questions.
- Collect the facts from the workspace or the conversation before drafting. Never invent figures, names, dates
  or quotations; mark anything unknown as a placeholder such as [TBD: Q3 revenue].

## Word (office_create, format docx)

- \`title\` is the document title. Put the body in \`blocks\`, in reading order.
- Structure with headings: level 1 for sections, level 2 for subsections, level 3 rarely.
- Keep paragraphs short (3-5 sentences). Use a list for parallel items and steps (\`ordered: true\` for steps).
- Use a table for anything compared across two or more attributes. Make the first row the header and keep
  columns few; split a wide table rather than squeezing it.
- Start long reports with a short summary section and end with conclusions or next steps.
- Use \`page_break\` only between major parts, for example before an appendix.

## PowerPoint (office_create, format pptx)

- One idea per slide. The title states the takeaway ("Revenue grew 12%"), not the topic ("Revenue").
- At most 5 bullets per slide and about 12 words per bullet. Move detail to \`notes\`.
- Open with a title slide (a slide with only \`title\`), close with a summary or next-steps slide, and use
  title-only slides as section dividers in decks longer than about 10 slides.
- Put numbers in a \`table\` slide rather than in bullets; keep tables to about 6 rows and 5 columns.

## Editing a template (office_edit)

- Read the template with office_inspect first and copy the exact text to replace, including punctuation.
- Prefer distinctive placeholders such as {{client_name}}: every occurrence of each \`from\` is replaced, so a
  short common word would change more than intended.
- The replacement takes the formatting of the text where the match starts.

## Checking the result

- After creating or editing, read the output back with office_inspect and confirm the content, order and
  that no placeholder is left unfilled by mistake.
- For a visual check, office_preview with an .html output works everywhere. A .pdf output needs Microsoft
  Office or LibreOffice on this machine; if neither is available, say so and offer the HTML preview.
- Hand the file to the user with present, and tell them what is in it and anything left for them to fill in.
`;

const BUILTIN: Record<string, string> = { 'office-documents': OFFICE_DOCUMENTS };

export function builtinSkills(): SkillInfo[] {
  return Object.entries(BUILTIN).map(([name, text]) => ({
    name,
    description:
      text
        .match(/^description:\s*(.+)$/m)?.[1]
        ?.trim()
        .slice(0, 256) ?? name,
    path: BUILTIN_SKILL_PREFIX + name,
  }));
}

/** The body of a built-in skill by its catalogue path, or `undefined` for a path that names a workspace file. */
export function builtinSkillText(skillPath: string): string | undefined {
  if (!skillPath.startsWith(BUILTIN_SKILL_PREFIX)) return undefined;
  return BUILTIN[skillPath.slice(BUILTIN_SKILL_PREFIX.length)];
}
