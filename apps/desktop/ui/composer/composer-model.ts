/**
 * Sending: the three pieces of state a message goes through, without the composer's DOM.
 *
 * A message is not one request. It may be queued for after the live turn, sent outright, or refused before it leaves
 * (an attachment the bridge cannot format); the run it starts can be stopped from the same button; and the task queue
 * behind it can be cleared. `sending`, `stopping` and `queueBusy` are that state — written only here, read by the
 * window's render to keep the composer's controls honest.
 *
 * Two rules carried over verbatim from the legacy module:
 *
 * - "sending" belongs to the session that sent. A run keeps going when another session is opened, so the flag is a
 *   list of sessions, not one boolean for the window.
 * - a failed send gives its text and attachments back **only** to the session it was written in, and only when the
 *   composer is still empty — otherwise it would overwrite what the person has typed since.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { DocumentAttachment } from '../../attachment-contract.ts';
import { attachmentPrompt } from '../../attachment-contract.ts';
import type { ImageAttachment } from '../../../../packages/protocol/index.ts';
import type { SlashOutcome } from './command-model.ts';

export interface ComposerAttachments {
  images(): ImageAttachment[];
  documents(): DocumentAttachment[];
  hasAny(): boolean;
  clear(): void;
  restore(images: ImageAttachment[], documents: DocumentAttachment[]): void;
}

export interface ComposerController {
  submit(): Promise<void>;
  stop(): Promise<void>;
  refreshTasks(): Promise<void>;
  clearQueue(): Promise<void>;
  applyPrompt(text: string): void;
  isSending(): boolean;
  isStopping(): boolean;
  isQueueBusy(): boolean;
}

export function createComposerController(deps: {
  getState(): CarrierSnapshot | null;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  requestRender(): void;
  setError(message: string | null): void;
  attachments: ComposerAttachments;
  commands: { submitSlash(text: string, hasAttachments: boolean): SlashOutcome | null };
  getPrompt(): string;
  setPrompt(text: string): void;
  isPromptDisabled(): boolean;
  focusPrompt(): void;
}): ComposerController {
  /** One entry per send in flight, so a send made in another session is not "sending" here. */
  const sendingSessions: (string | null)[] = [];
  const identity = (): string => {
    const state = deps.getState();
    return JSON.stringify([state?.workspace ?? '', state?.session.sessionId ?? null]);
  };
  /** The slash path sends one shell-owned command; it is "sending" while that request is in flight. */
  let sending = false;
  let stopping = false;
  let queueBusy = false;

  const controller: ComposerController = {
    async submit() {
      if (deps.isPromptDisabled()) return;
      const text = deps.getPrompt();
      if (!text.trim() && !deps.attachments.hasAny()) return;
      const slash = deps.commands.submitSlash(text.trim(), deps.attachments.hasAny());
      if (slash) {
        if ('error' in slash) {
          deps.setError(slash.error);
          deps.requestRender();
          return;
        }
        deps.setError(null);
        sending = true;
        deps.requestRender();
        try {
          await deps.invoke(slash.command);
        } finally {
          sending = false;
          deps.requestRender();
          deps.focusPrompt();
        }
        return;
      }
      const fromSession = identity();
      const documents = deps.attachments.documents();
      let outgoingText: string;
      try {
        outgoingText = attachmentPrompt(text, documents);
      } catch (error) {
        deps.setError(error instanceof Error ? error.message : String(error));
        deps.requestRender();
        return;
      }
      const images = deps.attachments.images();
      const queuing = Boolean(deps.getState()?.session.running);
      deps.setPrompt('');
      deps.attachments.clear();
      deps.setError(null);
      if (queuing) queueBusy = true;
      else sendingSessions.push(fromSession);
      deps.requestRender();
      const command: CarrierCommand = queuing
        ? { type: 'enqueue', prompt: outgoingText, images, mode: 'follow-up' }
        : { type: 'send', prompt: outgoingText, images };
      try {
        const ok = await deps.invoke(command);
        if (!ok && !deps.getPrompt() && identity() === fromSession) {
          deps.setPrompt(text);
          deps.attachments.restore(images, documents);
        }
      } finally {
        if (queuing) queueBusy = false;
        else {
          const index = sendingSessions.indexOf(fromSession);
          if (index >= 0) sendingSessions.splice(index, 1);
        }
        deps.requestRender();
        deps.focusPrompt();
      }
    },
    async stop() {
      if (!deps.getState()?.session.running || stopping) return;
      stopping = true;
      deps.requestRender();
      try {
        await deps.invoke({ type: 'cancel' });
      } finally {
        stopping = false;
        deps.requestRender();
      }
    },
    async refreshTasks() {
      await deps.invoke({ type: 'taskRefresh' });
    },
    async clearQueue() {
      queueBusy = true;
      deps.requestRender();
      try {
        await deps.invoke({ type: 'clearQueue' });
      } finally {
        queueBusy = false;
        deps.requestRender();
      }
    },
    applyPrompt(text) {
      if (deps.isPromptDisabled()) return;
      deps.setPrompt(text);
      deps.requestRender();
      deps.focusPrompt();
    },
    isSending: () => sending || sendingSessions.includes(identity()),
    isStopping: () => stopping,
    isQueueBusy: () => queueBusy,
  };
  return controller;
}
