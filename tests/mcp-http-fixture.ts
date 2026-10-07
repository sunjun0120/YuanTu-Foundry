import { createServer, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
export async function mcpHttpFixture(
  t: TestContext,
  handler: (body: any, response: ServerResponse) => void,
  sse = false,
) {
  const errors: unknown[] = [];
  let stream: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        if (!sse) {
          res.writeHead(405);
          res.end();
          return;
        }
        stream = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (!sse) {
        handler(body, res);
        return;
      }
      res.writeHead(202);
      res.end();
      handler(body, {
        writeHead: () => {},
        end: (value?: string) => {
          if (value) stream?.write('event: message\ndata: ' + value + '\n\n');
        },
      } as unknown as ServerResponse);
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
  if (!address || typeof address === 'string') throw Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
