import type { Message, Provider } from '../protocol/index.ts';

/**
 * A provider for a connection that does not accept images, with tool images held back at request
 * time (user images are refused before the run). Done per request, not in the transcript, so
 * switching models works both ways. The text says what was held back, so a visual check is reported
 * as not done.
 */
export function textOnlyProvider(provider: Provider): Provider {
  return {
    ...(provider.route ? { route: provider.route } : {}),
    complete: (request) =>
      provider.complete({ ...request, messages: withholdToolImages(request.messages) }),
  };
}

function withholdToolImages(messages: Message[]): Message[] {
  if (!messages.some((message) => message.role === 'tool' && message.images?.length))
    return messages;
  return messages.map((message) => {
    if (message.role !== 'tool' || !message.images?.length) return message;
    const { images, ...rest } = message;
    return {
      ...rest,
      content:
        `${message.content}\n[${images.length} image(s) not sent: the current model does not accept images. ` +
        'Layout and other visual details were not checked.]',
    };
  });
}
