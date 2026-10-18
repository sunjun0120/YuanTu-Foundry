import { RunFailure, failureCodeOf } from '../protocol/failure.ts';
const DONE = Symbol('stream.done');
/** One frame's event, {@link DONE} for an allowed `[DONE]`, or undefined for a frame without data. */
function parseFrame(
  frame: string,
  allowDone: boolean,
): Record<string, unknown> | typeof DONE | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  if (allowDone && data === '[DONE]') return DONE;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error('Invalid JSON in model stream');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('Invalid stream event');
  return event as Record<string, unknown>;
}
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  allowDone = false,
  idleTimeoutMs = 300_000,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    bufferedBytes = 0,
    searchFrom = 0;
  // Bound one in-flight event, not the cumulative stream. Reasoning and protocol overhead can
  // exceed several MB while the visible answer remains small; completed frames are discarded.
  const maxFrameBytes = 16_000_000;
  const boundaryPattern = /\r?\n\r?\n/g;
  try {
    while (true) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RunFailure('timeout', 'Model stream idle timeout')),
          idleTimeoutMs,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } catch (error) {
        /**
         * A read that rejects is one of two things, and they are not interchangeable.
         *
         * The idle bound above is ours and already named, so it keeps its code. Everything else that arrives
         * here is the connection: `fetch` answered, the stream started, and the body failed while being read —
         * a closed socket, a cut connection, a gateway that went away. That is the same event the adapters
         * already name when a stream ends without its terminal event, and leaving it anonymous made it
         * invisible to the retry policy, which fail-closes on a failure it cannot classify.
         *
         * A cancellation is deliberately *not* classified: aborting the request errors the body, so a Stop
         * arrives here too, and `throwIfAborted` reports the reason the caller gave rather than a wrapper that
         * would look like weather worth re-sending. A named failure is never re-wrapped either — the code it
         * carries is the answer.
         */
        if (failureCodeOf(error) !== undefined) throw error;
        signal.throwIfAborted();
        throw new RunFailure(
          'transport',
          'Model stream interrupted; check endpoint and network configuration',
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
      const { value, done } = chunk;
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      buffer += decoded;
      bufferedBytes += Buffer.byteLength(decoded, 'utf8');
      // Search only the newly appended suffix. A terminal Responses event can contain megabytes of
      // completed text; rescanning the entire unfinished frame for every transport chunk is quadratic.
      // Keep three old characters because a CRLF boundary may be split across chunks.
      while (true) {
        boundaryPattern.lastIndex = searchFrom;
        const boundary = boundaryPattern.exec(buffer);
        if (!boundary) {
          searchFrom = Math.max(0, buffer.length - 3);
          break;
        }
        const frame = buffer.slice(0, boundary.index);
        if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes)
          throw new Error('Model stream frame exceeds 16MB limit');
        buffer = buffer.slice(boundary.index + boundary[0].length);
        bufferedBytes = Buffer.byteLength(buffer, 'utf8');
        searchFrom = 0;
        const event = parseFrame(frame, allowDone);
        if (event === undefined) continue;
        if (event === DONE) {
          yield { type: 'stream.done' };
          return;
        }
        yield event;
      }
      if (bufferedBytes > maxFrameBytes) throw new Error('Model stream frame exceeds 16MB limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      /**
       * The body ended without the blank line that closes its last frame.
       *
       * Some OpenAI-compatible gateways end with `data: [DONE]\n` and close: every line of that frame is complete,
       * only the separator is missing, and refusing it failed every answer from them at the very end. A frame whose
       * lines are all complete is therefore read; one cut inside a line (no newline at the end, or a payload that
       * does not parse) is still the half frame it always was.
       */
      if (!/\r?\n$/.test(buffer)) throw new Error('Incomplete model stream frame');
      let event: Record<string, unknown> | typeof DONE | undefined;
      try {
        event = parseFrame(buffer.replace(/(?:\r?\n)+$/, ''), allowDone);
      } catch {
        throw new Error('Incomplete model stream frame');
      }
      if (event === DONE) yield { type: 'stream.done' };
      else if (event !== undefined) yield event;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
