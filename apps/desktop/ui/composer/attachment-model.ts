/**
 * The attachment strip's state: the images and documents staged for the next message.
 *
 * Everything downstream reads the lists by position — the submit sends `images` as an array, the document splitter
 * reads the text, the remove buttons splice by index — so the arrays are the state and the strip is a projection.
 *
 * Intake is one path for the picker, a paste and a drop because the rules are the same whichever door the file came
 * through: the count cap, the image/document split, `validateImages`, the size limits and the prompt validation. The
 * one place that remembers which session and workspace the files were read for is here too: a file read for a window
 * that has since switched sessions is discarded, not attached to the wrong conversation.
 */
import {
  attachmentPrompt,
  MAX_DOCUMENT_BYTES,
  type DocumentAttachment,
} from '../../attachment-contract.ts';
import type { ImageAttachment } from '../../../../packages/protocol/index.ts';
import { validateImages, MAX_IMAGE_BYTES } from '../../../../packages/protocol/images.ts';
import { format, t } from '../../i18n.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export type AttachmentFailure = 'count' | 'vision' | 'imageBytes' | 'imageRead' | 'documentBytes';

const FAILURE_KEYS: Record<AttachmentFailure, string> = {
  count: 'attach.rendererCount',
  vision: 'attach.visionModelRequired',
  imageBytes: 'attach.rendererImageBytes',
  imageRead: 'attach.rendererImageRead',
  documentBytes: 'attach.rendererDocumentBytes',
};

export function attachmentFailureText(kind: AttachmentFailure): string {
  return t(FAILURE_KEYS[kind]);
}

/** A refusal carries the file's name in front; the separator is part of the dictionary entry. */
export function attachmentFailureLine(name: string, message: string): string {
  return format(t('attach.rendererFailure'), { name, message });
}

/** The count cap covers images and documents together. */
export const MAX_ATTACHMENTS = 8;

const IMAGE_TYPES: Record<string, ImageAttachment['mimeType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The image MIME type a file claims, by extension first and by its own type second. */
export function imageMimeType(file: {
  name: string;
  type: string;
}): ImageAttachment['mimeType'] | undefined {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const byExtension = IMAGE_TYPES[extension ?? ''];
  if (byExtension) return byExtension;
  return file.type.startsWith('image/') ? (file.type as ImageAttachment['mimeType']) : undefined;
}

export interface AttachmentState {
  images: ImageAttachment[];
  documents: DocumentAttachment[];
  busy: boolean;
}

export interface AttachmentContext {
  sessionId: string | null;
  workspace: string;
  supportsVision: boolean;
  disabled: boolean;
  promptText: string;
}

export interface AttachmentsController {
  readonly store: ReadableStore<AttachmentState>;
  images(): ImageAttachment[];
  documents(): DocumentAttachment[];
  hasAny(): boolean;
  clear(): void;
  restore(images: ImageAttachment[], documents: DocumentAttachment[]): void;
  attach(files: File[]): Promise<void>;
  removeImage(index: number): void;
  removeDocument(index: number): void;
  isBusy(): boolean;
  dispose(): void;
}

export function createAttachmentsController(deps: {
  getContext(): AttachmentContext;
  /** Read a file's base64 body; the DOM adapter uses FileReader, the test hands back a value. */
  readImage(file: File): Promise<string>;
  /** Hand a document to the main process and get its extracted form back. */
  readDocument(file: File): Promise<DocumentAttachment>;
  setError(message: string | null): void;
  onChange(): void;
}): AttachmentsController {
  const store = createStore<AttachmentState>({ images: [], documents: [], busy: false });
  let disposed = false;
  let images: ImageAttachment[] = [];
  let documents: DocumentAttachment[] = [];
  const publish = (): void => {
    if (!disposed) store.set({ images, documents, busy: store.getSnapshot().busy });
  };
  const setBusy = (busy: boolean): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), busy });
  };

  const controller: AttachmentsController = {
    store,
    images: () => images,
    documents: () => documents,
    hasAny: () => images.length > 0 || documents.length > 0,
    clear() {
      images = [];
      documents = [];
      publish();
    },
    restore(nextImages, nextDocuments) {
      images = nextImages;
      documents = nextDocuments;
      publish();
    },
    removeImage(index) {
      images = images.filter((_, at) => at !== index);
      publish();
      deps.onChange();
    },
    removeDocument(index) {
      documents = documents.filter((_, at) => at !== index);
      publish();
      deps.onChange();
    },
    async attach(files) {
      const context = deps.getContext();
      if (!files.length || store.getSnapshot().busy || context.disabled) return;
      setBusy(true);
      deps.setError(null);
      const sessionId = context.sessionId;
      const workspace = context.workspace;
      deps.onChange();
      try {
        if (files.length + images.length + documents.length > MAX_ATTACHMENTS)
          throw new Error(attachmentFailureText('count'));
        const nextImages = [...images];
        const nextDocuments = [...documents];
        for (const file of files) {
          try {
            const mimeType = imageMimeType(file);
            if (mimeType) {
              if (!deps.getContext().supportsVision)
                throw new Error(attachmentFailureText('vision'));
              if (file.size > MAX_IMAGE_BYTES) throw new Error(attachmentFailureText('imageBytes'));
              const data = await deps.readImage(file);
              nextImages.push({
                mimeType,
                data,
                name: file.name || 'pasted-image.png',
              });
              validateImages(nextImages);
            } else {
              if (file.size > MAX_DOCUMENT_BYTES)
                throw new Error(attachmentFailureText('documentBytes'));
              const document = await deps.readDocument(file);
              nextDocuments.push(document);
              attachmentPrompt(deps.getContext().promptText, nextDocuments);
            }
          } catch (error) {
            throw new Error(
              attachmentFailureLine(
                file.name,
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        }
        const now = deps.getContext();
        // A file read for another session or project is discarded, not attached to the wrong conversation.
        if (sessionId !== now.sessionId || workspace !== now.workspace) return;
        images = validateImages(nextImages);
        documents = nextDocuments;
        publish();
      } catch (error) {
        deps.setError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        deps.onChange();
      }
    },
    isBusy: () => store.getSnapshot().busy,
    dispose() {
      disposed = true;
    },
  };
  return controller;
}
