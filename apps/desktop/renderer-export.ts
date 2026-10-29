import { t, translate } from './i18n.ts';
import type { UiLanguage } from './ui-settings.ts';

/**
 * The markdown a person gets when they export a conversation.
 *
 * This is the one surface the DOM walker cannot reach: what it produces is a file, not a node, so no walker ever
 * sees it and the language has to be chosen where the text is written. The three role names and the fallback title
 * were literals before this, which meant an English interface exported a document whose headings were Chinese.
 *
 * The message bodies are passed through untouched: they are the conversation, and a transcript is content the
 * application does not own (see `desktop-app-3`).
 */
export interface ExportableMessage {
  role: string;
  content: string;
}
export function conversationMarkdown(input: {
  title?: string | undefined;
  messages: readonly ExportableMessage[];
  language?: UiLanguage;
  /** How many older messages the export left out; see `CarrierService.exportTranscript`. */
  omitted?: number;
}): string {
  const text = (key: string, values?: Record<string, number>) =>
    input.language ? translate(key, input.language, values) : t(key, values);
  const title = input.title?.trim() || text('ui.export.untitled');
  const roleOf = (role: string): string =>
    role === 'user'
      ? text('ui.export.roleUser')
      : role === 'assistant'
        ? text('ui.export.roleAssistant')
        : text('ui.export.roleTool');
  const notice = input.omitted
    ? `> ${text('ui.export.omitted', { count: input.omitted })}\n\n`
    : '';
  return `# ${title}\n\n${notice}${input.messages
    .map((message) => `## ${roleOf(message.role)}\n\n${message.content}`)
    .join('\n\n')}`;
}
