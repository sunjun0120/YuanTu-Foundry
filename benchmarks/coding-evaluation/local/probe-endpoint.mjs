/**
 * Pre-flight for a paid endpoint: does this credential, model id and protocol actually work, and what limits does
 * the endpoint accept? Nothing here is a product test — it exists so a live batch is not the first thing that
 * discovers a typo in a model id or an endpoint that cannot stream.
 *
 * The key is read from `YUANTU_API_KEY` and never printed, echoed into a file, or included in the output.
 *
 * Usage:
 *   $env:YUANTU_API_KEY='<key>'; node benchmarks/coding-evaluation/local/probe-endpoint.mjs <baseUrl> <model>
 *
 * What it reports:
 *   1. `GET /models` — reachable, and whether the model id is in the catalogue.
 *   2. one non-streaming completion — status, finish reason, usage shape.
 *   3. one streamed completion with `stream_options.include_usage` — the exact shape the product's openai provider
 *      asks for, plus whether usage arrives on the stream.
 *   4. an output cap the manifest is allowed to declare (8192) and a large prompt, to check the endpoint accepts
 *      the window a manifest will claim.
 */
const base = process.argv[2]?.replace(/\/$/, '');
const model = process.argv[3];
const key = process.env.YUANTU_API_KEY;
if (!base || !model) throw new Error('usage: probe-endpoint.mjs <baseUrl> <model>');
if (!key) throw new Error('YUANTU_API_KEY is not set');

const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const sum = (usage) =>
  usage ? `${usage.prompt_tokens} in / ${usage.completion_tokens} out` : 'no usage';

const listed = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) });
if (!listed.ok) {
  console.log(`GET /models: status ${listed.status}`);
} else {
  const catalogue = await listed.json();
  const ids = (catalogue.data ?? []).map((entry) => entry.id);
  console.log(`GET /models: ${ids.length} models, id present: ${ids.includes(model)}`);
  const entry = (catalogue.data ?? []).find((item) => item.id === model);
  if (entry) console.log(`model entry: ${JSON.stringify(entry)}`);
}

async function ask(label, body) {
  const started = Date.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...body }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`${label}: status ${response.status} body=${text.slice(0, 200)}`);
    return;
  }
  const parsed = JSON.parse(text);
  console.log(
    `${label}: status ${response.status} in ${Date.now() - started}ms finish=${parsed.choices?.[0]?.finish_reason} usage=${sum(parsed.usage)}`,
  );
}

await ask('non-streaming', {
  messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  max_tokens: 64,
  stream: false,
});

// The manifest may declare at most 8192 output tokens; confirm the endpoint accepts that number.
await ask('max_tokens=8192', {
  messages: [{ role: 'user', content: 'Say ok.' }],
  max_tokens: 8192,
});

// A large prompt is what tells us the declared context window is real rather than aspirational.
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(4000);
await ask('~40k-token prompt', {
  messages: [{ role: 'user', content: `${filler}\nReply with exactly: ok` }],
  max_tokens: 16,
});

const streamed = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Write one short sentence about a cat.' }],
    max_tokens: 512,
    stream: true,
    stream_options: { include_usage: true },
  }),
  signal: AbortSignal.timeout(120_000),
});
if (!streamed.ok) {
  console.log(`stream: status ${streamed.status} body=${(await streamed.text()).slice(0, 200)}`);
} else {
  const reader = streamed.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frames = 0;
  let text = '';
  let usage = null;
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        finished = true;
        break;
      }
      frames++;
      const parsed = JSON.parse(payload);
      text += parsed.choices?.[0]?.delta?.content ?? '';
      if (parsed.usage) usage = parsed.usage;
    }
  }
  console.log(
    `stream: frames=${frames} text=${JSON.stringify(text.slice(0, 80))} usage=${usage ? sum(usage) : 'no usage on stream'}`,
  );
}
