import type { Message, Provider } from '../protocol/index.ts';

/**
 * A provider for a connection that does not accept images, with every tool picture held back from it.
 *
 * A user's own picture is refused before the run starts (`Agent.run`), but a tool's is not: `read_image`,
 * `browser_screenshot` and the like return pictures as part of their result, and a text-only endpoint rejects the
 * next request that carries one — the run fails a step later, somewhere that is not the tool. Held back here, at
 * the request rather than in the transcript, so a picture taken under a vision model is shown again after the
 * session switches back to one, and one taken earlier is not sent after switching away.
 *
 * The text says what was held back, so the model knows it did not see the picture and reports a visual check as
 * not done rather than as passed.
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
