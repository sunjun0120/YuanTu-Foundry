/**
 * Mount the attachment strip and wire the three ways in — the picker, a paste and a drop.
 *
 * The strip is React; the composer form around it is not yet, so this adapter owns the input element and the
 * composer's listeners and answers the sender's questions (`images()`, `hasAny()`, `restore()`), the same surface the
 * legacy module offered.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { DocumentAttachment } from '../../attachment-contract.ts';
import type { ImageAttachment } from '../../../../packages/protocol/index.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import { Attachments } from './Attachments.tsx';
import { attachmentFailureText, createAttachmentsController } from './attachment-model.ts';

export interface AttachmentsHandle {
  images(): ImageAttachment[];
  documents(): DocumentAttachment[];
  hasAny(): boolean;
  clear(): void;
  restore(images: ImageAttachment[], documents: DocumentAttachment[]): void;
  attach(files: File[]): void;
  isBusy(): boolean;
  dispose(): void;
}

export function mountAttachments(deps: {
  getState(): CarrierSnapshot | null;
  requestRender(): void;
  setError(message: string | null): void;
}): AttachmentsHandle {
  const host = document.getElementById('attachments-root');
  const prompt = document.getElementById('prompt') as HTMLTextAreaElement | null;
  const composer = document.getElementById('composer');
  const imageInput = document.getElementById('image-input') as HTMLInputElement | null;
  const controller = createAttachmentsController({
    getContext: () => {
      const state = deps.getState();
      return {
        sessionId: state?.session.sessionId ?? null,
        workspace: state?.workspace ?? '',
        supportsVision: state?.supportsVision ?? false,
        disabled: prompt?.disabled ?? true,
        promptText: prompt?.value ?? '',
      };
    },
    readImage: (file) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error(attachmentFailureText('imageRead')));
        reader.readAsDataURL(file);
      }),
    readDocument: async (file) => {
      const reply = await window.yuantu.readAttachment({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.file;
    },
    setError: deps.setError,
    onChange: deps.requestRender,
  });
  const disposeRegion = host
    ? mountRegion('attachments', host, <Attachments controller={controller} />)
    : () => {};
  const attachButton = document.getElementById('attach-image');
  const openPicker = (): void => imageInput?.click();
  const onInputChange = (): void => {
    const files = Array.from(imageInput?.files ?? []);
    if (imageInput) imageInput.value = '';
    void controller.attach(files);
  };
  const onPaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void controller.attach(files);
  };
  const onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  };
  const onDrop = (event: DragEvent): void => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void controller.attach(files);
  };
  attachButton?.addEventListener('click', openPicker);
  imageInput?.addEventListener('change', onInputChange);
  prompt?.addEventListener('paste', onPaste);
  composer?.addEventListener('dragover', onDragOver);
  composer?.addEventListener('drop', onDrop);
  return {
    images: () => controller.images(),
    documents: () => controller.documents(),
    hasAny: () => controller.hasAny(),
    clear: () => controller.clear(),
    restore: (images, documents) => controller.restore(images, documents),
    attach: (files) => void controller.attach(files),
    isBusy: () => controller.isBusy(),
    dispose: () => {
      disposeRegion();
      attachButton?.removeEventListener('click', openPicker);
      imageInput?.removeEventListener('change', onInputChange);
      prompt?.removeEventListener('paste', onPaste);
      composer?.removeEventListener('dragover', onDragOver);
      composer?.removeEventListener('drop', onDrop);
      controller.dispose();
    },
  };
}
