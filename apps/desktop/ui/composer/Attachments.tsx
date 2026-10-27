/**
 * The attachment strip: the documents and pictures staged for the next message.
 *
 * The arrays live in `attachment-model.ts`; this file projects them, by position (a card has no identity beyond its
 * slot). A picture opens a preview dialog; every card has a remove button whose label names what it removes.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { ImageAttachment } from '../../../../packages/protocol/index.ts';
import type { AttachmentsController } from './attachment-model.ts';

function ImagePreview({ image, onClose }: { image: ImageAttachment; onClose(): void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-preview-dialog"
      onClick={() => onClose()}
      onClose={() => onClose()}
    >
      <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name || t('ui.image')} />
    </dialog>
  );
}

export function Attachments({ controller }: { controller: AttachmentsController }): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const [preview, setPreview] = useState<ImageAttachment | null>(null);
  return (
    <>
      <div id="attachments" className="attachments" aria-label={t('ui.attachmentsLabel')}>
        {state.documents.map((document, index) => (
          <div
            key={`document:${index}:${document.name}`}
            className="attachment document-attachment"
          >
            <span className="document-icon">▤</span>
            <span
              title={`${document.name}\n${t('ui.attachmentCharacters', { count: document.text.length })}`}
            >
              {document.name}
            </span>
            <button
              type="button"
              className="attachment-remove"
              disabled={state.busy}
              aria-label={t('ui.removeAttachment', { name: document.name })}
              title={t('ui.removeAttachment', { name: document.name })}
              onClick={() => controller.removeDocument(index)}
            >
              ×
            </button>
          </div>
        ))}
        {state.images.map((image, index) => {
          const name = image.name || t('ui.image');
          return (
            <div key={`image:${index}:${name}`} className="attachment">
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={name}
                title={name}
                onClick={() => setPreview(image)}
              />
              <button
                type="button"
                className="attachment-remove"
                disabled={state.busy}
                aria-label={t('ui.removeImage', { name })}
                title={t('ui.removeImage', { name })}
                onClick={(event) => {
                  event.stopPropagation();
                  controller.removeImage(index);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}
