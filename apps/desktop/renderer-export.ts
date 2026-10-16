import { t } from './i18n.ts';

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
}): string {
  const title = input.title?.trim() || t('ui.export.untitled');
  const roleOf = (role: string): string =>
    role === 'user'
      ? t('ui.export.roleUser')
      : role === 'assistant'
        ? t('ui.export.roleAssistant')
        : t('ui.export.roleTool');
  return `# ${title}\n\n${input.messages
    .map((message) => `## ${roleOf(message.role)}\n\n${message.content}`)
    .join('\n\n')}`;
}
