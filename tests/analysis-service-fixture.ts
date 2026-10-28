// tests/analysis-service-fixture.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

export interface FixtureTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface AnalysisFixtureState {
  tools: FixtureTool[];
  beforeInitialize?: () => Promise<void>;
  /** Answers `tools/call` with an MCP CallToolResult. */
  call: (name: string, args: Record<string, unknown>) => unknown;
  uploads: { bytes: number; contentType: string; filename?: string }[];
  uploadReply: { status: number; body: unknown };
  reports: Map<string, { type: string; body: Buffer }>;
  methods: string[];
}

/** A stand-in for the backend: an MCP endpoint at /mcp, an upload endpoint and report files. */
export async function analysisServiceFixture(t: TestContext) {
  const state: AnalysisFixtureState = {
    tools: [],
    call: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    uploads: [],
    uploadReply: { status: 200, body: { project_id: 'p-1' } },
    reports: new Map(),
    methods: [],
  };
  const errors: unknown[] = [];
  const read = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fixture');
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = JSON.parse((await read(req)).toString('utf8'));
        state.methods.push(body.method);
        if (body.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        let result: unknown;
        if (body.method === 'initialize') {
          await state.beforeInitialize?.();
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'analysis-fixture', version: '1' },
          };
        } else if (body.method === 'tools/list') result = { tools: state.tools };
        else if (body.method === 'tools/call') {
          /**
           * A failing call is part of what some tests ask for, not a broken fixture: answer 500 and keep this
           * error out of `errors`, so a test can fail one call and assert the next one still works.
           */
          try {
            result = await state.call(body.params.name, body.params.arguments ?? {});
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
            return;
          }
        } else {
          json(res, 200, {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'not found' },
          });
          return;
        }
        json(res, 200, { jsonrpc: '2.0', id: body.id, result });
        return;
      }
      if (url.pathname === '/upload' && req.method === 'POST') {
        const bytes = await read(req);
        state.uploads.push({
          bytes: bytes.length,
          contentType: String(req.headers['content-type'] ?? ''),
          filename: /filename="([^"]+)"/.exec(bytes.toString('latin1'))?.[1],
        });
        json(res, state.uploadReply.status, state.uploadReply.body);
        return;
      }
      if (url.pathname.startsWith('/reports/') && req.method === 'GET') {
        const report = state.reports.get(url.pathname.slice('/reports/'.length));
        if (!report) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': report.type, 'content-length': report.body.length });
        res.end(report.body);
        return;
      }
      if (url.pathname === '/redirect') {
        res.writeHead(302, { location: '/reports/elsewhere.pdf' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
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
  if (!address || typeof address === 'string') throw new Error('No address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, state };
}
