#!/usr/bin/env node
/**
 * The local half of the web carrier: a Host, a page, and one WebSocket between them.
 *
 * The browser cannot spawn a process, cannot open a TCP socket and must never hold an API key, so something has
 * to sit on the machine and speak for it. That something is this process — and it is a *carrier*, not a second
 * implementation of one: it spawns the Host through `spawnedCarrier` (the same supervision and crash recovery the
 * desktop gets), and everything a page sends is a `CarrierCommand` dispatched to the same service. The decisions
 * this file makes are the three that had to be settled before it could be written:
 *
 * 1. **Who starts the Host**: the bridge does, and it therefore also owns the recovery. Attaching to a Host
 *    somebody else started is `connectedCarrier`'s shape and stays a later, explicit flag — a desktop-owned Host
 *    already holds the one connection it accepts, so it could not serve this page anyway.
 * 2. **Where credentials come from**: this process's environment (or `--settings <file>`, a plain JSON file the
 *    operator owns). The page never receives a key, and there is no model-settings page in the web UI: the
 *    desktop's encrypted store is Electron's `safeStorage`, and pretending otherwise would mean shipping the
 *    key to a browser.
 * 3. **What a second tab gets**: the Host's own refusal, reported rather than papered over. Approvals, runs and
 *    the workspace lock are per Host, so one page owns the Host and the next one is told exactly that.
 *
 * Everything else is transport: a static page, a WebSocket, and frames carrying the state the carrier already
 * publishes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { spawnedCarrier } from '../../packages/carrier/index.ts';
import type { CarrierService } from '../../packages/carrier/index.ts';
import {
  FrameDecoder,
  MessageAssembler,
  WebSocketProtocolError,
  acceptKey,
  encodeClose,
  encodePong,
  encodeText,
} from './websocket.ts';
import { parseBridgeRequest, type BridgeFrame } from './protocol.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..', '..');

interface Options {
  readonly workspace: string;
  readonly port: number;
  readonly token: string;
  readonly page: string;
  readonly settings?: string;
  /** The Host's environment. Defaults to this process's own; a test passes the connection it wants to exercise. */
  readonly env?: NodeJS.ProcessEnv;
}

/** The bridge's own arguments, refused rather than guessed: a typo here would serve the wrong workspace. */
export function parseBridgeArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new Error(
        'Usage: node apps/web/main.ts [--workspace <dir>] [--port <n>] [--token <string>] [--page <dir>] [--settings <file>]',
      );
    if (values.has(key)) throw new Error(`Repeated option: ${key}`);
    values.set(key, value);
  }
  for (const key of values.keys())
    if (!['--workspace', '--port', '--token', '--page', '--settings'].includes(key))
      throw new Error(`Unknown option: ${key}`);
  const port = values.has('--port') ? Number(values.get('--port')) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error('--port must be a whole number between 0 and 65535');
  return {
    workspace: path.resolve(values.get('--workspace') ?? process.cwd()),
    port,
    token: values.get('--token') ?? randomBytes(24).toString('base64url'),
    page: path.resolve(values.get('--page') ?? path.join(here, 'dist')),
    ...(values.has('--settings') ? { settings: path.resolve(values.get('--settings')!) } : {}),
  };
}

/** The Host entry this checkout can actually run: the built one when the build has run, the source otherwise. */
function hostEntry(): string {
  const built = path.join(project, 'dist', 'apps', 'agent-host', 'main.js');
  return existsSync(built) ? built : path.join(project, 'apps', 'agent-host', 'main.ts');
}

/** What a `--settings` file may carry: the connection the Host runs under. Keys are plain text and the file is the operator's. */
interface SettingsFile {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
}

async function settingsEnvironment(file: string | undefined): Promise<NodeJS.ProcessEnv> {
  if (!file) return {};
  const parsed = JSON.parse(await readFile(file, 'utf8')) as SettingsFile;
  return {
    ...(parsed.model ? { YUANTU_MODEL: parsed.model } : {}),
    ...(parsed.apiKey ? { YUANTU_API_KEY: parsed.apiKey } : {}),
    ...(parsed.baseUrl ? { YUANTU_BASE_URL: parsed.baseUrl } : {}),
    ...(parsed.protocol ? { YUANTU_PROTOCOL: parsed.protocol } : {}),
    ...(parsed.maxContextTokens === undefined
      ? {}
      : { YUANTU_MAX_CONTEXT_TOKENS: String(parsed.maxContextTokens) }),
    ...(parsed.maxOutputTokens === undefined
      ? {}
      : { YUANTU_MAX_OUTPUT_TOKENS: String(parsed.maxOutputTokens) }),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * One connected page.
 *
 * A page gets frames; it does not get to be a second owner. `refuse()` sends the reason *and* closes, because a
 * socket left open after "no" would look like a bridge that dropped the message.
 */
class PageLink {
  private readonly decoder = new FrameDecoder();
  private readonly assembler = new MessageAssembler();
  private readonly socket: Socket;
  private readonly onRequest: (text: string) => void;
  private readonly onGone: (link: PageLink) => void;
  private closed = false;
  constructor(socket: Socket, onRequest: (text: string) => void, onGone: (link: PageLink) => void) {
    this.socket = socket;
    this.onRequest = onRequest;
    this.onGone = onGone;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }
  /** One frame to the page, as JSON text. A closed link is a no-op: the state it missed arrives on reconnect. */
  write(frame: BridgeFrame): void {
    if (!this.closed && !this.socket.destroyed)
      this.socket.write(encodeText(JSON.stringify(frame)));
  }
  private receive(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk))
        for (const message of this.assembler.push(frame)) {
          if (message.kind === 'text') this.onRequest(message.text);
          else if (message.kind === 'ping') this.socket.write(encodePong(message.payload));
          else if (message.kind === 'close') this.refuse(1000, 'the page closed the link');
        }
    } catch (error) {
      // A protocol error is answered with a close code and a reason, never with silence.
      const reason = error instanceof WebSocketProtocolError ? error.message : 'invalid frame';
      this.refuse(error instanceof WebSocketProtocolError ? error.closeCode : 1002, reason);
    }
  }
  refuse(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.write(encodeText(JSON.stringify({ kind: 'refused', reason })));
    this.socket.write(encodeClose(code, reason));
    this.socket.end();
  }
  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    this.onGone(this);
  }
  get live(): boolean {
    return !this.closed && !this.socket.destroyed;
  }
}

/** Start the bridge: returns what a caller (or a test) needs to talk to it and to shut it down. */
export async function startBridge(options: Options): Promise<{
  readonly url: string;
  readonly carrier: CarrierService;
  close(): Promise<void>;
}> {
  const env = {
    ...process.env,
    ...options.env,
    ...(await settingsEnvironment(options.settings)),
  };
  const carrier = spawnedCarrier({
    nodePath: process.env.YUANTU_NODE_PATH ?? process.execPath,
    hostPath: hostEntry(),
    workspace: options.workspace,
    env,
  });
  let link: PageLink | undefined;
  const send = (frame: BridgeFrame): void => {
    link?.write(frame);
  };
  // The carrier publishes snapshots, tokens and numbers on four channels; all four travel to the page, because
  // the reason they are separate is that one snapshot per token copies the whole session.
  carrier.subscribe((state) => send({ kind: 'state', state }));
  carrier.subscribeDelta((delta) => send({ kind: 'delta', delta }));
  carrier.subscribeSubAgentDelta((delta) => send({ kind: 'subagent-delta', delta }));
  carrier.subscribeStatisticsDelta((delta) => send({ kind: 'statistics-delta', delta }));

  const onRequest = (text: string): void => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        send({ kind: 'refused', reason: 'a bridge frame must be JSON' });
        return;
      }
      const request = parseBridgeRequest(parsed);
      if ('error' in request) {
        send({ kind: 'refused', reason: request.error });
        return;
      }
      try {
        if (request.kind === 'command') {
          if (request.command?.type === 'sandbox')
            throw new Error('The sandbox is fixed by the bridge launch configuration.');
          // `dispatch` owns the vocabulary: an unknown or malformed command throws there, and the page gets the
          // same sentence the desktop would have shown.
          send({
            kind: 'reply',
            id: request.id,
            ok: true,
            value: await carrier.dispatch(request.command),
          });
        } else {
          const command = request.command;
          const reply =
            command.type === 'list'
              ? await carrier.listWorkspaceFiles(command.path ? { path: command.path } : {})
              : await carrier.readWorkspaceFile({ path: command.path });
          send({ kind: 'reply', id: request.id, ok: true, value: reply });
        }
      } catch (error) {
        send({ kind: 'reply', id: request.id, ok: false, error: carrier.safeError(error) });
      }
    })();
  };

  const server = createServer((request, response) => {
    void servePage(request, response, options).catch(() => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('internal server error');
      }
    });
  });
  /** Every socket this bridge upgraded, so shutdown can end them itself (see `close`). */
  const sockets = new Set<Socket>();
  server.on('upgrade', (request, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const remote = request.socket.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!loopback) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== options.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (link?.live) {
      // The Host accepts one connection, and so does this bridge: approvals, runs and the workspace lock are per
      // Host. The refusal is handed to the *new* socket — with the Host's own words — and the connected page is
      // left alone, which is the difference between refusing a second tab and dropping the first one.
      upgrade(socket, key);
      socket.write(
        encodeText(JSON.stringify({ kind: 'refused', reason: SECOND_CONNECTION_REFUSAL })),
      );
      socket.write(encodeClose(1008, SECOND_CONNECTION_REFUSAL));
      socket.end();
      return;
    }
    upgrade(socket, key);
    const created = new PageLink(socket, onRequest, (gone) => {
      if (link === gone) link = undefined;
    });
    link = created;
    // The page's first frame is the state it would otherwise have to ask for, so a reload shows the session
    // immediately instead of after one round trip.
    if (carrier.snapshot) send({ kind: 'state', state: carrier.snapshot });
  });
  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  await carrier.start();
  if (carrier.snapshot) send({ kind: 'state', state: carrier.snapshot });
  return {
    url: `http://127.0.0.1:${String(port)}/?token=${options.token}`,
    carrier,
    async close() {
      link?.refuse(1001, 'the bridge is shutting down');
      await carrier.stop().catch(() => {});
      /**
       * An upgraded socket is one the HTTP server has handed over, so `close()` alone can wait for a page that
       * will never say goodbye — a tab that was killed, or the second page refused a moment ago. Ending them
       * explicitly is what makes "the bridge is shutting down" finish.
       */
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The Host accepts one connection; this bridge repeats its sentence rather than inventing a softer one. */
const SECOND_CONNECTION_REFUSAL =
  'Agent Host already has a connected client; one connection at a time (the approvals, runs and workspace lock are per Host)';
/** Complete the handshake on a socket that has already been accepted for upgrade. */
function upgrade(socket: Socket, key: string): void {
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  );
}

/** The page and its assets, from one directory, with path traversal refused rather than resolved. */
async function servePage(
  request: IncomingMessage,
  response: ServerResponse,
  options: Options,
): Promise<void> {
  let url: URL;
  let relative: string;
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1');
    relative =
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('bad request');
    return;
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const target = path.resolve(options.page, relative);
  if (target !== options.page && !target.startsWith(options.page + path.sep)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseBridgeArgs(process.argv.slice(2));
  const bridge = await startBridge(options);
  process.stdout.write(`[web] ${bridge.url}\n[web] workspace: ${options.workspace}\n`);
  const shutdown = (): void => {
    void bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
