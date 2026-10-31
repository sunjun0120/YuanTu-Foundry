import type { ImageAttachment, Message } from '../../protocol/index.ts';
import { expandSkill } from '../../resources/skills.ts';
import { builtinServiceConfigured } from '../../builtin-services/manifest.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { AgentOptions } from '../agent-options.ts';
import type { RunEmit } from './emit.ts';

/**
 * What a run writes into the transcript as a user message: the person's input, and context a policy
 * or the progress guard injects. Everything model-visible must be in the transcript.
 */

/**
 * A message the person typed, with a skill invocation expanded. The model reads the expansion; the
 * typed text is kept for display.
 */
export function userMessage(options: {
  workspace: string;
  prompt: string;
  createdAt: string;
  images: ImageAttachment[] | undefined;
  modelInfo: AgentOptions['modelInfo'];
}): Message {
  const { workspace, prompt, createdAt, images, modelInfo } = options;
  const expanded = expandSkill(workspace, prompt, { analysisService: builtinServiceConfigured() });
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
