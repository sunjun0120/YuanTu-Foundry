/**
 * Sending: the composer's own controls and the three pieces of state a send goes through.
 *
 * A message is not one request. It may be queued for after the live turn, sent outright, or refused before it
 * leaves (an attachment the bridge cannot format); the run it starts can be stopped from the same button; and
 * the task queue behind it can be cleared. `sending`, `stopping` and `queueBusy` are that state — each one is
 * written only here and read by the window's render to keep the composer's controls honest — which is why the
 * module owns them and hands out the questions rather than the flags.
 *
 * The submit listener is also where the palette's typed commands meet the composer: a line that names one of
 * them is *asked* of `commands` and the command it answers with is run here, because running it means holding
 * the send state this module owns.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { attachmentPrompt, type DocumentAttachment } from './attachment-contract.ts';
import type { ImageAttachment } from '../../packages/protocol/index.ts';
import { type SlashOutcome } from './ui/composer/command-model.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

export function setupComposer(actions: {
  getState(): CarrierSnapshot | null;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  requestRender(): void;
  setError(message: string | null): void;
  attachments: {
    images(): ImageAttachment[];
    documents(): DocumentAttachment[];
    hasAny(): boolean;
    clear(): void;
    restore(images: ImageAttachment[], documents: DocumentAttachment[]): void;
  };
  commands: { submitSlash(text: string, hasAttachments: boolean): SlashOutcome | null };
}): {
  isSending(): boolean;
  isStopping(): boolean;
  isQueueBusy(): boolean;
} {
  const prompt = required<HTMLTextAreaElement>('prompt');
  const sendButton = required<HTMLButtonElement>('send');
  const composer = required<HTMLFormElement>('composer');
  let sending = false;
  /**
   * The session a send was made in. A send lasts as long as its run, and that run keeps going when another
   * session is opened, so "sending" is only true of the sessions that sent — one entry per send in flight.
   */
  const sendingSessions: (string | null)[] = [];
  let stopping = false;
  let queueBusy = false;

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (prompt.disabled || (!prompt.value.trim() && !actions.attachments.hasAny())) return;
    const text = prompt.value.trim();
    const slash = actions.commands.submitSlash(text, actions.attachments.hasAny());
    if (slash) {
      if ('error' in slash) {
        actions.setError(slash.error);
        actions.requestRender();
        return;
      }
      actions.setError(null);
      sending = true;
      actions.requestRender();
      void actions.invoke(slash.command).finally(() => {
        sending = false;
        actions.requestRender();
        prompt.focus();
      });
      return;
    }
    const textToSend = prompt.value;
    const files = actions.attachments.documents();
    let outgoingText: string;
    try {
      outgoingText = attachmentPrompt(textToSend, files);
    } catch (error) {
      actions.setError(error instanceof Error ? error.message : String(error));
      actions.requestRender();
      return;
    }
    const images = actions.attachments.images();
    const queuing = Boolean(actions.getState()?.session.running);
    prompt.value = '';
    actions.attachments.clear();
    actions.setError(null);
    const fromSession = actions.getState()?.session.sessionId ?? null;
    if (queuing) queueBusy = true;
    else sendingSessions.push(fromSession);
    actions.requestRender();
    const command: CarrierCommand = queuing
      ? { type: 'enqueue', prompt: outgoingText, images, mode: 'follow-up' }
      : {
          type: 'send',
          prompt: outgoingText,
          images,
        };
    void actions
      .invoke(command)
      .then((ok) => {
        // A failed send gives its text back only to the session it was written in.
        if (!ok && !prompt.value && actions.getState()?.session.sessionId === fromSession) {
          prompt.value = textToSend;
          actions.attachments.restore(images, files);
        }
      })
      .finally(() => {
        if (queuing) queueBusy = false;
        else sendingSessions.splice(sendingSessions.indexOf(fromSession), 1);
        actions.requestRender();
        prompt.focus();
      });
  });
  required('refresh-tasks').addEventListener(
    'click',
    () => void actions.invoke({ type: 'taskRefresh' }),
  );
  required('clear-queue').addEventListener('click', () => {
    queueBusy = true;
    actions.requestRender();
    void actions.invoke({ type: 'clearQueue' }).finally(() => {
      queueBusy = false;
      actions.requestRender();
    });
  });
  sendButton.addEventListener('click', (event) => {
    if (!actions.getState()?.session.running) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    actions.requestRender();
    void actions.invoke({ type: 'cancel' }).finally(() => {
      stopping = false;
      actions.requestRender();
    });
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-prompt]')) {
    button.addEventListener('click', () => {
      if (!prompt.disabled) {
        prompt.value = button.dataset.prompt!;
        actions.requestRender();
        prompt.focus();
      }
    });
  }
  return {
    isSending: () =>
      sending || sendingSessions.includes(actions.getState()?.session.sessionId ?? null),
    isStopping: () => stopping,
    isQueueBusy: () => queueBusy,
  };
}
