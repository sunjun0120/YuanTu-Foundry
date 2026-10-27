/**
 * The composer's DOM seam: the listeners the window owns and the prompt element the controller reads and writes.
 *
 * The send/queue/stop rules live in `ui/composer/composer-model.ts`; this file keeps the one thing that is still the
 * legacy window's — where the buttons are and what a submit means. When the composer region itself moves to React,
 * this adapter becomes props on the form.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { DocumentAttachment } from '../../attachment-contract.ts';
import type { ImageAttachment } from '../../../../packages/protocol/index.ts';
import { type SlashOutcome } from './command-model.ts';
import { createComposerController } from './composer-model.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

export function connectComposer(actions: {
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
  dispose(): void;
} {
  const lifecycle = new AbortController();
  const prompt = required<HTMLTextAreaElement>('prompt');
  const sendButton = required<HTMLButtonElement>('send');
  const composer = required<HTMLFormElement>('composer');
  const controller = createComposerController({
    getState: actions.getState,
    invoke: actions.invoke,
    requestRender: actions.requestRender,
    setError: actions.setError,
    attachments: {
      images: actions.attachments.images,
      documents: actions.attachments.documents,
      hasAny: actions.attachments.hasAny,
      clear: actions.attachments.clear,
      restore: actions.attachments.restore,
    },
    commands: actions.commands,
    getPrompt: () => prompt.value,
    setPrompt: (text) => {
      prompt.value = text;
    },
    isPromptDisabled: () => prompt.disabled,
    focusPrompt: () => prompt.focus(),
  });

  composer.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void controller.submit();
    },
    { signal: lifecycle.signal },
  );
  sendButton.addEventListener(
    'click',
    (event) => {
      if (!actions.getState()?.session.running) return;
      event.preventDefault();
      void controller.stop();
    },
    { signal: lifecycle.signal },
  );
  required('refresh-tasks').addEventListener('click', () => void controller.refreshTasks(), {
    signal: lifecycle.signal,
  });
  required('clear-queue').addEventListener('click', () => void controller.clearQueue(), {
    signal: lifecycle.signal,
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-prompt]')) {
    button.addEventListener('click', () => controller.applyPrompt(button.dataset.prompt!), {
      signal: lifecycle.signal,
    });
  }
  return {
    isSending: () => controller.isSending(),
    isStopping: () => controller.isStopping(),
    isQueueBusy: () => controller.isQueueBusy(),
    dispose: () => lifecycle.abort(),
  };
}
