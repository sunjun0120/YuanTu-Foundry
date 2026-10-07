import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

/**
 * Prompt caching makes Anthropic's `system` field a block array. Fixtures that only care
 * about the prompt text read both shapes instead of pinning the wire format here.
 */
export function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

export function frames(
  text: string,
  calls: { id: string; name: string; input: Record<string, unknown> }[] = [],
) {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'fixture-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
  ];
  let index = 0;
  if (text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    events.push({ type: 'content_block_stop', index });
    index++;
  }
  for (const call of calls) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    });
    const json = JSON.stringify(call.input),
      middle = Math.floor(json.length / 2);
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(0, middle) },
    });
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(middle) },
    });
    events.push({ type: 'content_block_stop', index });
    index++;
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  events.push({ type: 'message_stop' });
  return events;
}
/**
 * Write one fixture answer as an SSE stream.
 *
 * `pauseBeforeEndMs` holds the answer's own end back, which is what gives a fixture a decode span: the panel
 * reports output speed over the half of a step that follows its first token, and a stream delivered in one
 * burst has no such half — it would report a throughput of the fixture rather than of a stream. Real streams
 * pause there because tokens take time; a fixture that means to exercise the reading has to pause too.
 */
export function sendFrames(
  res: ServerResponse,
  events: Record<string, unknown>[],
  pauseBeforeEndMs = 0,
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const encode = (list: Record<string, unknown>[]) =>
    Buffer.from(
      list
        .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
        .join(''),
    );
  const write = (bytes: Buffer) => {
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
  };
  // The last two events are the terminal stop reason and `message_stop`: holding exactly those back keeps
  // every content-bearing frame on the wire before the pause.
  const split = pauseBeforeEndMs > 0 ? Math.max(0, events.length - 2) : events.length;
  write(encode(events.slice(0, split)));
  if (split === events.length) {
    res.end();
    return;
  }
  setTimeout(() => {
    write(encode(events.slice(split)));
    res.end();
  }, pauseBeforeEndMs);
}
export async function httpFixture(
  t: TestContext,
  handler: (
    body: any,
    res: ServerResponse,
    headers: Record<string, string | string[] | undefined>,
    requestPath: string,
  ) => void | Promise<void>,
) {
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      // A GET has no body, and a probe like the model catalogue is a GET: parsing "" as JSON would answer 500
      // for a request that was perfectly well formed, which reads as an endpoint fault instead of a probe.
      await handler(raw.trim() ? JSON.parse(raw) : {}, res, req.headers, req.url ?? '');
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (errors.length) throw errors[0];
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}
