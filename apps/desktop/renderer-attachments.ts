/**
 * What is attached to the message being written: the pictures and documents staged in the composer, and the
 * strip that shows them.
 *
 * The two lists live here rather than in the DOM because everything downstream reads them by position — the
 * submit sends `images` as an array, the transcript's own splitter reads the document text, and the remove
 * buttons splice by index — so the array is the state and the strip is a projection of it, rebuilt on every
 * change instead of patched. That is also why the strip is keyed by index: a card has no identity beyond the
 * slot it occupies.
 *
 * Intake is deliberately one path (`attach`) for all three ways in — the picker, a paste, a drop — because the
 * rules are the same whichever door the file came through: the count cap, the image/document split by extension,
 * `validateImages` and the reader in the main process. It is also the one place that remembers which session and
 * workspace the files were read for, so a file dropped into a window that has since switched sessions is
 * discarded rather than attached to the wrong conversation.
 */
import {
  attachmentPrompt,
  MAX_DOCUMENT_BYTES,
  type DocumentAttachment,
} from './attachment-contract.ts';
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { ImageAttachment } from '../../packages/protocol/index.ts';
import { validateImages, MAX_IMAGE_BYTES } from '../../packages/protocol/images.ts';
import { t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
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

export function setupAttachments(actions: {
  getState(): CarrierSnapshot | null;
  requestRender(): void;
  setError(message: string | null): void;
}): {
  render(): void;
  images(): ImageAttachment[];
  documents(): DocumentAttachment[];
  hasAny(): boolean;
  clear(): void;
  restore(images: ImageAttachment[], documents: DocumentAttachment[]): void;
  attach(files: File[]): void;
  isBusy(): boolean;
} {
  const prompt = required<HTMLTextAreaElement>('prompt');
  const composer = required('composer');
  const imageInput = required<HTMLInputElement>('image-input');
  const strip = required('attachments');
  let attachments: ImageAttachment[] = [];
  let documentAttachments: DocumentAttachment[] = [];
  let imageBusy = false;
  function render(): void {
    strip.replaceChildren(
      ...documentAttachments.map((file, index) => {
        const card = node('div', '', 'attachment document-attachment');
        const label = node('span', file.name);
        label.title = file.name + '\n' + file.text.length + ' 字符';
        const remove = node('button', '×', 'attachment-remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', '移除附件 ' + file.name);
        remove.addEventListener('click', () => {
          documentAttachments.splice(index, 1);
          render();
          actions.requestRender();
        });
        card.append(node('span', '▤', 'document-icon'), label, remove);
        return card;
      }),
      ...attachments.map((image, index) => {
        const card = node('div', '', 'attachment');
        const preview = node('img');
        preview.src = `data:${image.mimeType};base64,${image.data}`;
        preview.alt = image.name || t('ui.image');
        preview.title = image.name || t('ui.image');
        preview.addEventListener('click', () => {
          const dialog = document.createElement('dialog');
          dialog.className = 'image-preview-dialog';
          const enlarged = document.createElement('img');
          enlarged.src = preview.src;
          enlarged.alt = preview.alt;
          dialog.append(enlarged);
          dialog.addEventListener('click', () => dialog.close());
          dialog.addEventListener('close', () => dialog.remove(), { once: true });
          document.body.append(dialog);
          dialog.showModal();
        });
        const remove = node('button', '×', 'attachment-remove');
        remove.type = 'button';
        remove.setAttribute(
          'aria-label',
          t('ui.removeImage', { name: image.name || t('ui.image') }),
        );
        remove.title = t('ui.removeImage', { name: image.name || t('ui.image') });
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          attachments.splice(index, 1);
          render();
          actions.requestRender();
        });
        card.append(preview, remove);
        return card;
      }),
    );
  }
  function images(): ImageAttachment[] {
    return attachments;
  }
  function documents(): DocumentAttachment[] {
    return documentAttachments;
  }
  function hasAny(): boolean {
    return Boolean(attachments.length || documentAttachments.length);
  }
  /** Drop what is staged — a session or workspace switch belongs to a different message. */
  function clear(): void {
    attachments = [];
    documentAttachments = [];
    render();
  }
  /** Put back what a failed send had taken, so nothing a person attached is lost to a bridge error. */
  function restore(images: ImageAttachment[], documents: DocumentAttachment[]): void {
    attachments = images;
    documentAttachments = documents;
    render();
  }
  function attach(files: File[]): void {
    if (!files.length || imageBusy || prompt.disabled) return;
    imageBusy = true;
    actions.setError(null);
    const sessionId = actions.getState()?.session.sessionId;
    const workspace = actions.getState()?.workspace;
    actions.requestRender();
    void (async () => {
      if (files.length + attachments.length + documentAttachments.length > 8)
        throw new Error('每条消息最多附加 8 个文件（其中图片最多 4 张）');
      const nextImages = [...attachments];
      const nextDocuments = [...documentAttachments];
      for (const file of files) {
        try {
          const extension = file.name.split('.').pop()?.toLowerCase();
          const imageTypes: Record<string, ImageAttachment['mimeType']> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          };
          const mimeType =
            imageTypes[extension || ''] || (file.type.startsWith('image/') ? file.type : undefined);
          if (mimeType) {
            if (!actions.getState()?.supportsVision)
              throw new Error('当前模型未启用图片输入，请切换支持图片的模型');
            if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5MB');
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
              reader.onerror = () => reject(new Error('图片读取失败'));
              reader.readAsDataURL(file);
            });
            nextImages.push({
              mimeType: mimeType as ImageAttachment['mimeType'],
              data,
              name: file.name || 'pasted-image.png',
            });
            validateImages(nextImages);
          } else {
            if (file.size > MAX_DOCUMENT_BYTES) throw new Error('单个文件不能超过 20MB');
            const reply = await window.yuantu.readAttachment({
              name: file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            });
            if (!reply.ok) throw new Error(reply.error);
            nextDocuments.push(reply.file);
            attachmentPrompt(prompt.value, nextDocuments);
          }
        } catch (error) {
          throw new Error(
            file.name + '：' + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      const state = actions.getState();
      if (sessionId !== state?.session.sessionId || workspace !== state?.workspace) return;
      attachments = validateImages(nextImages);
      documentAttachments = nextDocuments;
      render();
    })()
      .catch((error) => {
        actions.setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        imageBusy = false;
        actions.requestRender();
      });
  }
  function isBusy(): boolean {
    return imageBusy;
  }
  required('attach-image').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    const files = Array.from(imageInput.files ?? []);
    imageInput.value = '';
    attach(files);
  });
  prompt.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      event.preventDefault();
      attach(files);
    }
  });
  composer.addEventListener('dragover', (event) => {
    if ((event as DragEvent).dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  composer.addEventListener('drop', (event) => {
    const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
    if (files.length) {
      event.preventDefault();
      attach(files);
    }
  });
  return { render, images, documents, hasAny, clear, restore, attach, isBusy };
}
