import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tool, ToolContext } from '../packages/protocol/index.ts';
import { createTools } from '../packages/tools/index.ts';
import { htmlToText, parseDuckDuckGo, readWebConfig, webTools } from '../packages/tools/web.ts';
import type { WebConfig } from '../packages/tools/web.ts';
import { addressReason, assertPublicUrl } from '../packages/tools/network-guard.ts';
import { browserTools } from '../packages/tools/browser.ts';

// ---- merged from web.test.ts ----

async function serve(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}
function context(signal = new AbortController().signal): ToolContext {
  return { signal, approve: async () => true };
}
function pick(tools: Tool[], name: string): Tool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

test('htmlToText drops scripts and styles, decodes entities and keeps block structure', () => {
  const html = `<!doctype html><html><head><title>Hi &amp; Bye</title><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Heading</h1><p>Hello&nbsp;world &lt;tag&gt; &#65;&#x42;</p><ul><li>one</li><li>two</li></ul></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Hi & Bye');
  assert.ok(!text.includes('alert(1)'));
  assert.ok(!text.includes('color:red'));
  assert.ok(text.includes('Hello world <tag> AB'), text);
  assert.ok(text.includes('- one'));
  assert.ok(text.includes('- two'));
});

test('parseDuckDuckGo extracts titles, decoded redirect links and snippets', () => {
  const html = `
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
    <a class="result__snippet" href="x">A <b>snippet</b> about docs.</a></div>
    <div class="result"><a class="result__a" href="https://direct.example/page">Direct</a>
    <a class="result__snippet">Second snippet</a></div>`;
  const hits = parseDuckDuckGo(html, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.title, 'Example Docs');
  assert.equal(hits[0]!.url, 'https://example.com/docs');
  assert.equal(hits[0]!.snippet, 'A snippet about docs.');
  assert.equal(hits[1]!.url, 'https://direct.example/page');
});

test('readWebConfig defaults to the keyless provider and reads optional overrides', () => {
  assert.deepEqual(readWebConfig({}), { provider: 'duckduckgo' });
  assert.deepEqual(
    readWebConfig({
      YUANTU_SEARCH_PROVIDER: 'Brave',
      YUANTU_SEARCH_API_KEY: ' k ',
      YUANTU_SEARCH_BASE_URL: 'https://example.test/search',
    }),
    { provider: 'brave', apiKey: 'k', baseUrl: 'https://example.test/search' },
  );
});

test('web_fetch extracts readable text and refuses unsupported targets', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Doc</title><script>bad()</script></head><body><p>Body text</p></body></html>',
      );
      return;
    }
    if (req.url === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2, 3]));
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(500);
    res.end();
  });
  const tool = pick(webTools('/workspace'), 'web_fetch');

  const ok = await tool.execute({ url: `${base}/page` }, context());
  const payload = JSON.parse(ok.content) as Record<string, unknown>;
  assert.equal(ok.isError, false);
  assert.equal(payload.status, 200);
  assert.equal(payload.title, 'Doc');
  assert.equal(payload.contentType, 'text/html');
  assert.ok(String(payload.text).includes('Body text'));
  assert.ok(!String(payload.text).includes('bad()'));

  const missing = await tool.execute({ url: `${base}/missing` }, context());
  assert.equal(missing.isError, true);

  await assert.rejects(tool.execute({ url: `${base}/binary` }, context()), /content type/i);
  await assert.rejects(tool.execute({ url: 'file:///etc/passwd' }, context()), /http and https/i);
  await assert.rejects(
    tool.execute({ url: 'http://user:secret@example.com/' }, context()),
    /credentials/i,
  );
  await assert.rejects(
    tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, context()),
    /metadata/i,
  );
});

test('web_fetch bounds returned text by max_chars', async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5_000));
  });
  const tool = pick(webTools('/workspace'), 'web_fetch');
  const result = await tool.execute({ url: base, max_chars: 1_000 }, context());
  const payload = JSON.parse(result.content) as { text: string; truncated: boolean };
  assert.equal(payload.text.length, 1_000);
  assert.equal(payload.truncated, true);
});

test('web_search parses the keyless DuckDuckGo endpoint through a configured base URL', async (t) => {
  let query = '';
  const base = await serve(t, (req, res) => {
    query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a><a class="result__snippet">Snippet</a>',
    );
  });
  const tool = pick(
    webTools('/workspace', { provider: 'duckduckgo', baseUrl: `${base}/html/` }),
    'web_search',
  );
  const result = await tool.execute({ query: 'agent tools', count: 3 }, context());
  const payload = JSON.parse(result.content) as {
    provider: string;
    results: { title: string; url: string; snippet: string }[];
  };
  assert.equal(query, 'agent tools');
  assert.equal(payload.provider, 'duckduckgo');
  assert.deepEqual(payload.results, [
    { title: 'Example', url: 'https://example.com', snippet: 'Snippet' },
  ]);
});

test('web_search uses a configured API provider and never leaks its key', async (t) => {
  let token = '';
  const base = await serve(t, (_req, res) => {
    token = String(_req.headers['x-subscription-token'] ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        web: { results: [{ title: 'T', url: 'https://e.test', description: 'D' }] },
      }),
    );
  });
  const config: WebConfig = {
    provider: 'brave',
    apiKey: 'secret-key-123',
    baseUrl: `${base}/search`,
  };
  const tool = pick(webTools('/workspace', config), 'web_search');
  const result = await tool.execute({ query: 'q' }, context());
  assert.equal(token, 'secret-key-123');
  assert.ok(!result.content.includes('secret-key-123'));
  const payload = JSON.parse(result.content) as { provider: string; results: unknown[] };
  assert.equal(payload.provider, 'brave');
  assert.equal(payload.results.length, 1);
});

test('web_search preserves bounded network causes while redacting provider credentials', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error secret-fixture-key'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    });
  };
  const tool = pick(
    webTools('/workspace', {
      provider: 'tavily',
      apiKey: 'secret-fixture-key',
      baseUrl: 'http://127.0.0.1:12345/search',
    }),
    'web_search',
  );
  await assert.rejects(tool.execute({ query: 'synthetic' }, context()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(error.message, /Connect Timeout Error/);
    assert.ok(!error.message.includes('secret-fixture-key'));
    return true;
  });
});

test('web_search fails closed without a key and keeps it out of error text', async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'upstream failure' }));
  });
  const missing = pick(webTools('/workspace', { provider: 'tavily' }), 'web_search');
  await assert.rejects(missing.execute({ query: 'q' }, context()), /YUANTU_SEARCH_API_KEY/);

  const failing = pick(
    webTools('/workspace', {
      provider: 'brave',
      apiKey: 'secret-key-123',
      baseUrl: `${base}/search`,
    }),
    'web_search',
  );
  await assert.rejects(failing.execute({ query: 'q' }, context()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('secret-key-123'));
    return /HTTP 500/.test(error.message);
  });

  const unknown = pick(webTools('/workspace', { provider: 'nope' }), 'web_search');
  await assert.rejects(unknown.execute({ query: 'q' }, context()), /YUANTU_SEARCH_PROVIDER/);
});

test('web and browser tools require external or write approval through the registry', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-'));
  const registry = createTools(root);
  t.after(async () => {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  });
  const names = registry.specs().map((spec) => spec.name);
  for (const name of [
    'web_search',
    'web_fetch',
    'browser_open',
    'browser_click',
    'browser_fill',
    'browser_screenshot',
    'browser_close',
  ])
    assert.ok(names.includes(name), `missing tool ${name}`);

  const kinds: string[] = [];
  const denied = await registry.execute(
    { id: '1', name: 'web_search', arguments: { query: 'q' } },
    {
      signal: new AbortController().signal,
      approve: async (approval) => {
        kinds.push(approval.kind);
        return false;
      },
    },
  );
  assert.deepEqual(kinds, ['external']);
  assert.equal(denied.isError, true);

  const screenshot = await registry.execute(
    { id: '2', name: 'browser_screenshot', arguments: { path: 'shot.png' } },
    {
      signal: new AbortController().signal,
      approve: async (approval) => {
        kinds.push(approval.kind);
        return false;
      },
    },
  );
  assert.deepEqual(kinds, ['external', 'write']);
  assert.equal(screenshot.isError, true);
});

/**
 * Regression: the guard used to be a three-entry literal hostname set with `redirect: 'follow'`,
 * so a DNS alias, a numeric IP encoding or a single 302 all reached the metadata endpoint.
 */
test('the network guard refuses metadata, private and link-local addresses in every encoding', () => {
  const refused = [
    '169.254.169.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '203.0.113.9',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:169.254.169.254',
    '::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
    '64:ff9b::a9fe:a9fe',
  ];
  for (const address of refused)
    assert.ok(addressReason(address), `${address} should be refused but was allowed`);

  // Loopback and ordinary public addresses stay reachable (local dev servers, local gateways).
  for (const address of [
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '::ffff:127.0.0.1',
    '1.1.1.1',
    '2606:4700::1111',
  ])
    assert.equal(addressReason(address), null, `${address} should be allowed`);

  // URL-level: hostile literal spellings are normalized by the URL parser and then refused.
  const hostile = [
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/latest/meta-data/',
    'http://0xA9FEA9FE/',
    'http://0251.0376.0251.0376/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://10.0.0.5:8080/admin',
    'http://[fd00:ec2::254]/',
  ];
  for (const input of hostile) {
    assert.rejects(assertPublicUrl(new URL(input), {}), `expected ${input} to be refused`);
  }
  // The opt-in lifts the range checks but never the metadata addresses or names.
  assert.rejects(
    assertPublicUrl(new URL('http://169.254.169.254/'), { YUANTU_ALLOW_PRIVATE_NETWORK: '1' }),
  );
  assert.rejects(
    assertPublicUrl(new URL('http://metadata.google.internal/'), {
      YUANTU_ALLOW_PRIVATE_NETWORK: '1',
    }),
  );
  assert.rejects(
    assertPublicUrl(new URL('http://[fd00:ec2::254]/'), { YUANTU_ALLOW_PRIVATE_NETWORK: '1' }),
  );
});

test('web_fetch refuses a redirect to a link-local metadata address', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('final');
  });
  const tool = pick(webTools('/workspace'), 'web_fetch');
  await assert.rejects(
    tool.execute({ url: `${base}/redirect` }, context()),
    /metadata|link-local/i,
  );
});

test('web_fetch still follows an ordinary redirect chain between allowed hosts', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/one') {
      res.writeHead(301, { location: '/two' });
      res.end();
      return;
    }
    if (req.url === '/two') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('reached the end');
  });
  const tool = pick(webTools('/workspace'), 'web_fetch');
  const result = await tool.execute({ url: `${base}/one` }, context());
  assert.equal(result.isError, false, result.content);
  const payload = JSON.parse(result.content) as { status: number; text: string; url: string };
  assert.equal(payload.status, 200);
  assert.match(payload.text, /reached the end/);
  assert.match(payload.url, /\/final$/);
});

// ---- merged from browser.test.ts ----

async function serve2(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}
function context2(journal?: ToolContext['fileJournal']): ToolContext {
  return {
    signal: new AbortController().signal,
    approve: async () => true,
    ...(journal ? { fileJournal: journal } : {}),
  };
}
function pick2(tools: Tool[], name: string): Tool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const available = await chromiumAvailable();

test('browser tools fail closed with install guidance when chromium is unavailable', async (t) => {
  if (available) return t.skip('chromium is installed; the missing-browser path is unavailable');
  const { tools, close } = browserTools('/workspace');
  t.after(close);
  await assert.rejects(
    pick2(tools, 'browser_open').execute({ url: 'http://127.0.0.1:1/' }, context2()),
    /npx playwright install chromium/,
  );
});

test('browser tools render scripted pages, interact and screenshot into the journal', async (t) => {
  if (!available) return t.skip('chromium is not installed; run "npx playwright install chromium"');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-browser-'));
  const base = await serve2(t, (req, res) => {
    if (req.url === '/app') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>App</title></head><body><h1>Rendered</h1><div id="out"></div><input id="q"><button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button><script>document.getElementById('out').textContent='scripted';</script></body></html>`,
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  const { tools, close } = browserTools(root);
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  const opened = JSON.parse(
    (await pick2(tools, 'browser_open').execute({ url: `${base}/app` }, context2())).content,
  ) as { title: string; text: string; url: string };
  assert.equal(opened.title, 'App');
  assert.ok(opened.text.includes('Rendered'));
  assert.ok(opened.text.includes('scripted'), 'page scripts must run before extraction');

  const filled = JSON.parse(
    (await pick2(tools, 'browser_fill').execute({ selector: '#q', value: 'hello' }, context2()))
      .content,
  ) as { text: string };
  assert.ok(filled.text.includes('Rendered'));

  const clicked = JSON.parse(
    (await pick2(tools, 'browser_click').execute({ selector: '#go' }, context2())).content,
  ) as { text: string };
  assert.ok(clicked.text.includes('clicked'));

  const prepared: unknown[] = [];
  const applied: string[] = [];
  const shot = await pick2(tools, 'browser_screenshot').execute(
    { path: 'shot.png' },
    context2({
      prepare(change, before, after) {
        prepared.push({ change, before, after });
        return 'journal-1';
      },
      applied(id) {
        applied.push(id);
      },
    }),
  );
  const shotPayload = JSON.parse(shot.content) as {
    path: string;
    bytes: number;
    overwritten: boolean;
  };
  assert.equal(shotPayload.path, 'shot.png');
  assert.equal(shotPayload.overwritten, false);
  assert.deepEqual(applied, ['journal-1']);
  assert.equal(prepared.length, 1);
  const bytes = await readFile(path.join(root, 'shot.png'));
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47');
  assert.equal((await stat(path.join(root, 'shot.png'))).size, shotPayload.bytes);

  await pick2(tools, 'browser_close').execute({}, context2());
});
