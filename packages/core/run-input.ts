import type { ImageAttachment, Message } from '../protocol/index.ts';
import { expandSkill } from '../resources/skills.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { AgentOptions } from './agent-options.ts';
import type { RunEmit } from './run-emit.ts';

/**
 * What a run writes into the transcript as a user message: the person's own input, and the context a policy or
 * the progress guard asked to put in front of the model.
 *
 * Both are persisted user messages for one reason: everything model-visible has to be in the transcript (and
 * therefore in the summary, the compaction boundary and the session reader), so neither can ride along inside a
 * request without a record.
 */

/**
 * A message the person typed, with a skill invocation expanded.
 *
 * The expanded text is what the model reads; the typed text is kept as the display content when a skill
 * replaced it, so the transcript shows what the person wrote rather than the skill's body.
 */
export function userMessage(options: {
  workspace: string;
  prompt: string;
  createdAt: string;
  images: ImageAttachment[] | undefined;
  modelInfo: AgentOptions['modelInfo'];
}): Message {
  const { workspace, prompt, createdAt, images, modelInfo } = options;
  const expanded = expandSkill(workspace, prompt);
  return {
    role: 'user',
    createdAt,
    ...(modelInfo ? { modelInfo } : {}),
    content: expanded.prompt,
    ...(expanded.skill ? { displayContent: prompt } : {}),
    ...(images?.length ? { images } : {}),
  };
}

/** Persist injected context as a user message and tell the client where it came from. */
export function injectContext(
  store: SessionStore,
  sessionId: string,
  emit: RunEmit,
  content: string,
  details: Record<string, unknown> & { source: string },
): void {
  store.append(sessionId, { role: 'user', content });
  emit('context.injected', { ...details, content });
}
