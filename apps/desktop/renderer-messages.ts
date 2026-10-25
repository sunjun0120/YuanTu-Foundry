/**
 * What one message looks like: the transcript's leaf view, and the small pieces the message-level slots hang
 * off it.
 *
 * Everything here is a pure function of the message it is given and is called once per message per transcript
 * rebuild, so a view is never patched — a changed revision or a changed language replaces the whole list. The
 * two satellites (`messageTimeView`, `messageCopyView`) are contributions to `message.footer` and
 * `message.actions` rather than lines inside the bubble: the slot owns *where* they appear and in what order,
 * and these own what they say.
 */
import type { ImageAttachment, Message } from '../../packages/protocol/index.ts';
import { splitAttachmentPrompt } from './attachment-contract.ts';
import { locale, t } from './i18n.ts';
import { renderMarkdown, type MarkdownActions } from './markdown.ts';
import { toolCardModel, toolCardView } from './tool-cards.ts';
import type { RunEnding } from '../../packages/protocol/run-cancellation.ts';
import { localizedRunError } from './renderer-error-text.ts';

export function runEndingText(ending: RunEnding): string {
  if (ending.status === 'interrupted') return t('ui.unanswered.crash');
  if (ending.status !== 'cancelled')
    return ending.error
      ? (localizedRunError(ending.error, locale() === 'en-US') ?? ending.error)
      : t(`ui.runStatus.${ending.status}`);
  return t(
    ending.cancelReason === 'shutdown'
      ? 'ui.unanswered.shutdown'
      : ending.cancelReason === 'user'
        ? 'ui.unanswered.user'
        : 'ui.unanswered.cancelled',
  );
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

/**
 * One line for a refusal the kernel writes in English, when the refusal has a known shape.
 *
 * Tool-result text is evidence: the model read exactly these words, and a view that reworded them would be a
 * second account nobody could check. So the raw text stays where it is and this note is added above it — the
 * reader gets a sentence in their language, the evidence stays byte-for-byte what the model saw.
 */
export function toolFailureNote(message: {
  role: Message['role'];
  isError?: boolean;
  content: string;
}): string | null {
  if (message.role !== 'tool' || message.isError !== true) return null;
  const content = message.content;
  if (content.startsWith('Invalid arguments:')) return t('ui.toolArgumentsInvalid');
  if (content.startsWith('Verification checks are already registered'))
    return t('ui.toolCheckLocked');
  if (content.startsWith('Git tools need the repository root'))
    return t('ui.toolGitOutsideWorkspace');
  // Two preparation stages that stop a command before it starts. The raw text below either one carries the path,
  // the failed stage and the helper's own error; this line says which stage it was.
  if (
    content.startsWith('Sandboxed commands are blocked at Windows sandbox account initialization')
  )
    return t('ui.toolSandboxInitialization');
  if (content.startsWith('Windows sandbox workspace authorization is incomplete'))
    return t('ui.toolSandboxAuthorization');
  // A permission preset refused this call; nobody was asked. The card must not read as "you denied it".
  if (content.startsWith("Blocked by the session's permission policy"))
    return t('ui.toolPermissionPolicy');
  if (content.startsWith('Permission was not granted: no approval responder is available'))
    return t('ui.toolApprovalUnavailable');
  if (content.startsWith('Permission was not granted: nobody answered'))
    return t('ui.toolApprovalTimedOut');
  if (content.startsWith('Permission denied by user.')) return t('ui.toolApprovalDenied');
  return null;
}

export function setupMessages(options: {
  /** The hub's bridge-backed actions: markdown may only reach the outside world through these. */
  markdownActions: MarkdownActions;
  /** The hub's slot mounter, so a view inside a message gets its frames from the one registry. */
  mountMessageSlot(
    container: HTMLElement,
    slot: 'message.actions' | 'message.footer' | 'tool.result.extra',
    message: Message,
  ): void;
}): {
  imageGallery(images: readonly ImageAttachment[]): HTMLElement;
  messageTimeView(message: Message): HTMLElement;
  messageCopyView(message: Message): HTMLElement;
  processIcon(kind: string): HTMLElement;
  messageView(message: Message): HTMLElement;
  reasoningView(text: string): HTMLElement;
} {
  const { markdownActions, mountMessageSlot } = options;
  /**
   * The pictures a message carries, whichever role carries them.
   *
   * A user's attachment and a tool's output are shown the same way on purpose: from a person's side both are
   * "there is a picture in this conversation", and a screenshot the model was shown must be visible to the person
   * reading along — otherwise the model's answer about a layout is unverifiable.
   */
  function imageGallery(images: readonly ImageAttachment[]): HTMLElement {
    const gallery = node('div', '', 'message-images');
    for (const image of images) {
      const preview = node('img');
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      preview.alt = image.name || t('ui.image');
      gallery.append(preview);
    }
    return gallery;
  }
  /**
   * When a user message was sent, as the `message.footer` slot draws it.
   *
   * Its own function because it is now a contribution rather than a line inside `messageView`: the slot owns
   * *where* it appears and in what order, and this owns what it says.
   */
  function messageTimeView(message: Message): HTMLElement {
    const time = node('time', '—');
    // Only a user message carries a send time; another role in this slot says so rather than showing a fake one.
    const createdAt = 'createdAt' in message ? message.createdAt : undefined;
    const date = createdAt ? new Date(createdAt) : null;
    if (date && Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString(locale(), {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      time.title = date.toLocaleString(locale());
    } else {
      time.title = t('ui.sendTimeUnavailable');
    }
    return time;
  }
  /**
   * What a user-role message says to this reader.
   *
   * The completion repair prompt is written for the model, in English, and is stored as a user message so the
   * next request carries it. The transcript shows a one-line Chinese summary in its place; the completion panel
   * below carries the failed checks and their output.
   */
  const COMPLETION_REPAIR_PREFIX = 'Automated acceptance checks did not pass';
  function userText(message: Message): string {
    if (message.role !== 'user') return message.content;
    const shown = message.displayContent ?? message.content;
    return !message.displayContent && shown.startsWith(COMPLETION_REPAIR_PREFIX)
      ? t('ui.completionRepairSummary')
      : shown;
  }
  /** The copy button and its feedback, as the `message.actions` slot draws them. */
  function messageCopyView(message: Message): HTMLElement {
    const content = message.role === 'user' ? userText(message) : message.content;
    const copy = node('button', '', 'copy-user-message');
    copy.type = 'button';
    const label = () => t('ui.copyMessage');
    copy.title = label();
    copy.setAttribute('aria-label', label());
    copy.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="6" width="10" height="11" rx="2"/><path d="M7 6V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v6a2 2 0 0 1-2 2h-1"/></svg>';
    const feedback = node('span', '', 'user-copy-feedback');
    feedback.setAttribute('role', 'status');
    let reset: ReturnType<typeof setTimeout> | undefined;
    const copyContent = async (): Promise<void> => {
      copy.disabled = true;
      clearTimeout(reset);
      try {
        await markdownActions.copy(content);
        feedback.textContent = t('ui.copied');
      } catch {
        feedback.textContent = t('ui.copyFailed');
      } finally {
        copy.disabled = false;
        reset = setTimeout(() => {
          feedback.textContent = '';
        }, 1600);
      }
    };
    copy.addEventListener('click', () => void copyContent());
    const actions = node('span', '', 'user-message-actions');
    actions.append(feedback, copy);
    return actions;
  }
  function processIcon(kind: string): HTMLElement {
    const paths: Record<string, string> = {
      reasoning: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
      read: '<path d="M14 3H6v18h12V7Zm0 0v4h4M9 11h6m-6 4h6"/>',
      search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
      edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
      command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
      tool: '<path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-16-2 18"/>',
      result: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
      failed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
    };
    const icon = node('span', '', 'process-icon');
    icon.dataset.kind = kind;
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind] ?? paths.tool}</svg>`;
    return icon;
  }
  function messageView(message: Message): HTMLElement {
    if (message.role === 'tool') {
      const details = node('details', '', `tool-result${message.isError ? ' tool-error' : ''}`);
      const card = toolCardModel(message.output);
      const outputKind = card?.kind;
      const label = message.isError
        ? t('ui.operationFailed')
        : outputKind === 'file-read'
          ? t('ui.read')
          : outputKind === 'search-results'
            ? t('ui.search')
            : t(message.isError ? 'ui.operationFailed' : 'ui.toolResult');
      const summary = node('summary', '', `process-summary process-${outputKind ?? 'tool'}`);
      /*
       * What the line says after the label. A result the panel can describe (a path, a query, a command) says
       * that; it never falls back to the call id, which is an internal handle a person cannot use — an
       * interrupted tool used to read `操作未完成 · call_01_K3UyNHn…` and nothing else.
       */
      const preview =
        card?.kind === 'file-read'
          ? card.path
          : card?.kind === 'search-results'
            ? card.query
            : card?.kind === 'command-output'
              ? card.command
              : '';
      summary.append(
        processIcon(
          message.isError
            ? 'failed'
            : outputKind === 'file-read'
              ? 'read'
              : outputKind === 'search-results'
                ? 'search'
                : 'result',
        ),
        node('span', label, 'process-label'),
        ...(preview ? [node('span', `· ${preview}`, 'process-preview')] : []),
      );
      details.append(summary);
      // A card is drawn *beside* the text, never instead of it: the text is what the model was shown, and a view
      // that replaced it would be a second account of the same result that nobody could check. The payload is
      // validated before anything is drawn, so an unknown or half-written value falls through to the text below.
      if (card) {
        details.append(toolCardView(card));
        const raw = node('details', '', 'tool-result-raw');
        raw.append(node('summary', t('ui.toolCardRaw')), node('pre', message.content));
        details.append(raw);
      } else {
        // A refusal the kernel writes in English gets one line saying what happened, with the raw text kept
        // underneath: the model's evidence is unchanged, the reader is not left with only the English.
        const note = toolFailureNote(message);
        if (note) details.append(node('p', note, 'tool-error-note'));
        details.append(node('pre', message.content));
      }
      if (message.images?.length || (message.change && !message.isError))
        mountMessageSlot(details, 'tool.result.extra', message);
      return details;
    }
    const article = node(
      'article',
      '',
      `message ${message.role}${message.role === 'assistant' && !message.content.trim() ? ' process-only' : ''}`,
    );
    const body = message.role === 'user' ? node('div', '', 'user-bubble') : article;
    if (message.role === 'user') article.append(body);
    // The thought comes before the answer, folded: it is what explains the answer, not the answer. Rendering it
    // closed is also what keeps a reopened session's reasoning out of the way until it is asked for.
    if (message.role === 'assistant' && message.reasoning)
      body.append(reasoningView(message.reasoning));
    const content = message.role === 'user' ? userText(message) : message.content;
    const display =
      message.role === 'user' ? splitAttachmentPrompt(content) : { prompt: content, files: [] };
    if (display.prompt)
      body.append(
        message.role === 'assistant'
          ? renderMarkdown(content, markdownActions)
          : node('div', display.prompt, 'message-content'),
      );
    for (const file of display.files) {
      const details = node('details', '', 'message-document');
      details.append(node('summary', '▤ ' + file.file), node('pre', file.content));
      body.append(details);
    }
    if (message.role === 'user' && message.images?.length)
      body.append(imageGallery(message.images));
    if (message.role === 'user') {
      const meta = node('div', '', 'user-message-meta');
      article.append(meta);
      // Both halves of the row are slots: the order between them is the slots' decision now, not this line's.
      mountMessageSlot(meta, 'message.footer', message);
      mountMessageSlot(meta, 'message.actions', message);
    }
    if (message.role === 'assistant' && message.interrupted)
      article.append(node('p', t('ui.interruptedReply'), 'interrupted-reply'));
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) {
        const details = node('details', '', 'tool-call');
        details.dataset.callId = call.id;
        const kind =
          call.name === 'read_file'
            ? 'read'
            : call.name === 'search_files'
              ? 'search'
              : ['edit_file', 'write_file', 'apply_patch'].includes(call.name)
                ? 'edit'
                : ['run_command', 'start_command', 'run_code'].includes(call.name)
                  ? 'command'
                  : 'tool';
        const label =
          kind === 'read'
            ? t('ui.read')
            : kind === 'search'
              ? t('ui.search')
              : kind === 'edit'
                ? t('ui.edit')
                : t('ui.toolCall');
        const target =
          typeof call.arguments.path === 'string'
            ? call.arguments.path
            : typeof call.arguments.query === 'string'
              ? call.arguments.query
              : typeof call.arguments.command === 'string'
                ? call.arguments.command
                : call.name;
        const summary = node('summary', '', `process-summary process-${kind}`);
        summary.append(
          processIcon(kind),
          node('span', label, 'process-label'),
          node('span', `· ${target}`, 'process-preview'),
        );
        details.append(summary, node('pre', JSON.stringify(call.arguments, null, 2)));
        article.append(details);
      }
    return article;
  }
  /** Reasoning is kept complete; only its one-line preview is shortened. */
  function reasoningView(text: string): HTMLElement {
    const details = node('details', '', 'message-reasoning');
    const summary = node('summary', '', 'process-summary process-reasoning');
    summary.append(
      processIcon('reasoning'),
      node('span', t('ui.reasoning'), 'process-label'),
      node('span', text.replace(/\s+/g, ' ').slice(0, 240), 'process-preview'),
    );
    details.append(summary, node('pre', text, 'reasoning-content'));
    return details;
  }
  return {
    imageGallery,
    messageTimeView,
    messageCopyView,
    processIcon,
    messageView,
    reasoningView,
  };
}
