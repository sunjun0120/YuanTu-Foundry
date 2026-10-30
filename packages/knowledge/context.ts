import { maintainMemories, memorySummary } from './memory.ts';

/**
 * Bounded reminder of durable memory, announced into the conversation rather than put in the system prompt.
 *
 * The markdown files are the source of truth, so this reads them directly; detailed project knowledge stays
 * behind recall_knowledge. It is called once per round by the caller that announces runtime snapshots
 * (`packages/core/context/runtime.ts`), because memory is one of the two things in a session that change while it
 * runs — and a prompt section that changes is a cacheable prefix thrown away. The day's clean-up (archiving
 * memories unused for months) runs first, at most once a day, so the reminder it builds already says what moved.
 */
export async function memoryContext(root: string, globalDir?: string): Promise<string> {
  try {
    await maintainMemories(root, globalDir);
    return memorySummary(root, globalDir);
  } catch {
    return '\nSaved memories could not be loaded; use recall_knowledge if needed.';
  }
}
