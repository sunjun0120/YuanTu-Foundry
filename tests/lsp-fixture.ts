/**
 * Minimal LSP server used by tests. It is spawned as a script, so it stays
 * dependency-free and speaks raw Content-Length framing on stdio.
 *
 * Behaviour is driven by document content so tests stay deterministic:
 *   BADTOKEN      publish one error diagnostic on the line that contains it
 *   NODIAGNOSTICS never publish for this document, to exercise the wait timeout
 *   CRASH         exit immediately, to exercise crash detection
 *   MULTIFILE     make rename also edit the sibling second.fake
 *   RENAMEFILE    make rename answer with a file *rename* resource operation as well as a text edit,
 *                 which is the shape the tools refuse rather than half-apply
 *
 * Pass `--crash-on-start` to make it fail before the handshake, the way a
 * rustup proxy does when its component is missing.
 */
import { appendFileSync, writeSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--crash-on-start')) {
  // writeSync keeps this on fd 2 so it cannot be lost to process.exit.
  writeSync(2, 'fake-ls: missing component "fake-core"\n');
  process.exit(1);
}

/**
 * Reject `initialize` with a JSON-RPC error but keep running. A server in this state is the case
 * where a failed start must actively terminate it: nothing else will.
 */
const REJECT_ON_START = process.argv.includes('--reject-on-start');
/**
 * Accept requests after the handshake and never answer them. A server that has taken work it will not report on
 * is the case a Stop or a timeout has to end, and the only case where a cancellation is observable.
 */
const NEVER_ANSWER = process.argv.includes('--never-answer');
/**
 * Answer `initialize`, then write bytes that are not a frame at all. The client's decoder is the thing that
 * fails here, which is the path where the server must not be left running.
 */
const MALFORMED_OUTPUT = process.argv.includes('--malformed-output');
/**
 * When set, the server records that `shutdown` and `exit` actually arrived. A test uses this to
 * prove the client performed the graceful handshake instead of skipping it and killing the tree.
 */
const LIFECYCLE_MARKER = process.env.FAKE_LSP_LIFECYCLE_MARKER;
function markLifecycle(suffix: string): void {
  if (!LIFECYCLE_MARKER) return;
  try {
    writeFileSync(`${LIFECYCLE_MARKER}${suffix}`, 'ok');
  } catch {
    // The marker is a test aid; it must never be the reason a server misbehaves.
  }
}
/**
 * When set, every cancellation this server is told about is appended here.
 *
 * Read by a test that proves the client announces a request it stopped waiting for, rather than only forgetting
 * it: the difference between the two is invisible from the client's side, and expensive on this one.
 */
const CANCEL_MARKER = process.env.FAKE_LSP_CANCEL_MARKER;
function markCancel(id: unknown): void {
  if (!CANCEL_MARKER) return;
  try {
    appendFileSync(CANCEL_MARKER, `${String(id)}\n`);
  } catch {
    // Same rule as the lifecycle marker: a test aid never breaks the server.
  }
}
/**
 * When set, every document-lifecycle message this server receives is appended here.
 *
 * The client's document bookkeeping is invisible from its own side — a refresh that announces an already-open
 * document, a document closed and reopened, and one simply left open all look the same from the caller — so a
 * test that is about *which* message was sent has to hear it from the server.
 */
const SYNC_MARKER = process.env.FAKE_LSP_SYNC_MARKER;
function markSync(method: string, uri: unknown): void {
  if (!SYNC_MARKER) return;
  try {
    appendFileSync(SYNC_MARKER, `${method} ${String(uri)}\n`);
  } catch {
    /* see above */
  }
}
if (LIFECYCLE_MARKER) {
  // The pid is what a test watches when the question is whether this process is still alive at all.
  try {
    writeFileSync(`${LIFECYCLE_MARKER}.pid`, String(process.pid));
  } catch {
    /* see above */
  }
}

const SEPARATOR = '\r\n\r\n';
const documents = new Map<string, string>();
let buffer = Buffer.alloc(0);
let rootUri = '';

/** Line and UTF-16 column of a token, which is what LSP ranges are made of. */
function locate(text: string, token: string): { line: number; character: number } | undefined {
  const index = text.indexOf(token);
  if (index < 0) return undefined;
  const before = text.slice(0, index);
  return { line: before.split('\n').length - 1, character: index - (before.lastIndexOf('\n') + 1) };
}

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]),
  );
}
function diagnosticsFor(text: string): unknown[] {
  const diagnostics: unknown[] = [];
  text.split('\n').forEach((line, index) => {
    const column = line.indexOf('BADTOKEN');
    if (column < 0) return;
    diagnostics.push({
      range: {
        start: { line: index, character: column },
        end: { line: index, character: column + 8 },
      },
      severity: 1,
      code: 'fake/bad-token',
      source: 'fake-ls',
      message: 'BADTOKEN is not allowed',
    });
  });
  return diagnostics;
}
function publish(uri: string, text: string, version: unknown): void {
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, version, diagnostics: diagnosticsFor(text) },
  });
}
function sibling(uri: string, name: string): string {
  return `${uri.slice(0, uri.lastIndexOf('/') + 1)}${name}`;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
}

function handle(message: Incoming): void {
  // A message without a method is the client answering one of our requests.
  if (message.method === undefined) return;
  const params = message.params ?? {};
  if (message.method === '$/cancelRequest') {
    markCancel(params.id);
    return;
  }
  /**
   * Under `--never-answer` everything but the handshake and the shutdown is taken and dropped. The requests
   * themselves are still read, which is what makes the cancellation that follows them observable here.
   */
  if (
    NEVER_ANSWER &&
    message.method !== 'initialize' &&
    message.method !== 'initialized' &&
    message.method !== 'shutdown' &&
    message.method !== 'exit'
  )
    return;
  switch (message.method) {
    case 'initialize':
      if (REJECT_ON_START) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'fake-ls: cannot initialize this workspace' },
        });
        return;
      }
      rootUri = typeof params.rootUri === 'string' ? params.rootUri : '';
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            renameProvider: true,
            codeActionProvider: true,
            workspaceSymbolProvider: true,
          },
        },
      });
      // After the answer, so a client that fails to decode this has already completed its handshake: the failure
      // under test is the decoder's, not a start that could not finish.
      if (MALFORMED_OUTPUT) writeSync(1, 'Content-Length: nonsense\r\n\r\n');
      return;
    case 'initialized':
      // A server blocked on an unanswered request would stall; the client must reply.
      send({
        jsonrpc: '2.0',
        id: 'server-question',
        method: 'workspace/configuration',
        params: { items: [{ section: 'fake' }] },
      });
      return;
    case 'shutdown':
      markLifecycle('');
      send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    case 'exit':
      markLifecycle('.exited');
      process.exit(0);
    case 'textDocument/didOpen': {
      const document = params.textDocument;
      markSync('didOpen', document.uri);
      documents.set(document.uri, document.text);
      if (String(document.text).includes('CRASH')) process.exit(1);
      if (String(document.text).includes('NODIAGNOSTICS')) return;
      publish(document.uri, document.text, document.version);
      return;
    }
    case 'textDocument/didChange': {
      const uri = params.textDocument.uri;
      const text = params.contentChanges[0].text;
      markSync('didChange', uri);
      documents.set(uri, text);
      if (String(text).includes('NODIAGNOSTICS')) return;
      publish(uri, text, params.textDocument.version);
      return;
    }
    case 'textDocument/didClose': {
      // Forgetting the document is what makes a later `didChange` for it a protocol violation this fixture would
      // notice rather than ignore: the client has to open it again.
      markSync('didClose', params.textDocument.uri);
      documents.delete(params.textDocument.uri);
      return;
    }
    case 'textDocument/definition':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          uri: params.textDocument.uri,
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
        },
      });
      return;
    case 'textDocument/references':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [
          {
            uri: params.textDocument.uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          },
          {
            uri: sibling(params.textDocument.uri, 'other.fake'),
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          },
        ],
      });
      return;
    case 'textDocument/hover':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: { kind: 'markdown', value: '```ts\nconst TARGET: number\n```' },
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        },
      });
      return;
    case 'textDocument/documentSymbol':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [
          {
            name: 'outer',
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
            selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
            children: [
              {
                name: 'inner',
                kind: 13,
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
                selectionRange: {
                  start: { line: 1, character: 6 },
                  end: { line: 1, character: 11 },
                },
              },
            ],
          },
        ],
      });
      return;
    case 'textDocument/rename': {
      const uri = params.textDocument.uri;
      const text = documents.get(uri) ?? '';
      const column = text.indexOf('TARGET');
      if (column < 0) {
        send({ jsonrpc: '2.0', id: message.id, result: { changes: {} } });
        return;
      }
      const changes: Record<string, unknown[]> = {
        [uri]: [
          {
            range: {
              start: { line: 0, character: column },
              end: { line: 0, character: column + 6 },
            },
            newText: params.newName,
          },
        ],
      };
      /**
       * A `WorkspaceEdit` may also ask for file-level operations. Only text edits can be applied by the
       * tools, so this shape exists to prove the whole edit is refused: the text half must not be applied
       * while the move is dropped, which would rename references but leave the file where it was.
       */
      if (text.includes('RENAMEFILE')) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            documentChanges: [
              { kind: 'rename', oldUri: uri, newUri: sibling(uri, 'moved.fake') },
              {
                textDocument: { uri, version: null },
                edits: changes[uri],
              },
            ],
          },
        });
        return;
      }
      if (text.includes('MULTIFILE'))
        changes[sibling(uri, 'second.fake')] = [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            newText: params.newName,
          },
        ];
      send({ jsonrpc: '2.0', id: message.id, result: { changes } });
      return;
    }
    case 'textDocument/codeAction': {
      const uri = params.textDocument.uri;
      const text = documents.get(uri) ?? '';
      const at = locate(text, 'BADTOKEN');
      const actions: Record<string, unknown>[] = [];
      if (at) {
        actions.push({
          title: 'Replace BADTOKEN with GOODTOKEN',
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: params.context?.diagnostics ?? [],
          edit: {
            changes: {
              [uri]: [
                {
                  range: {
                    start: at,
                    end: { line: at.line, character: at.character + 8 },
                  },
                  newText: 'GOODTOKEN',
                },
              ],
            },
          },
        });
        // A command-only action: applying it would mean executing server logic.
        actions.push({
          title: 'Run a server command',
          kind: 'quickfix',
          command: { title: 'Run a server command', command: 'fake.run', arguments: [] },
        });
        // A disabled action must never be applied.
        actions.push({
          title: 'Disabled fix',
          kind: 'quickfix',
          disabled: { reason: 'not applicable here' },
        });
      } else
        actions.push({
          title: 'Remove unused declaration',
          kind: 'source.organizeImports',
          edit: {
            changes: {
              [uri]: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: '// tidied\n',
                },
              ],
            },
          },
        });
      const only = params.context?.only;
      const filtered =
        Array.isArray(only) && only.length
          ? actions.filter((action) => String(action.kind ?? '').startsWith(String(only[0])))
          : actions;
      send({ jsonrpc: '2.0', id: message.id, result: filtered });
      return;
    }
    case 'workspace/symbol': {
      const query = String(params.query ?? '').toLowerCase();
      const all = [
        {
          name: 'TARGET',
          kind: 13,
          containerName: 'outer',
          location: {
            uri: `${rootUri}/main.fake`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          },
        },
        {
          name: 'helper',
          kind: 12,
          location: {
            uri: `${rootUri}/other.fake`,
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
          },
        },
        {
          // Servers may return a file without a position.
          name: 'targetless',
          kind: 5,
          location: { uri: `${rootUri}/other.fake` },
        },
        {
          // Must be dropped: it is outside the workspace.
          name: 'TARGET_outside',
          kind: 5,
          location: {
            uri: 'file:///definitely/outside/workspace.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          },
        },
      ];
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: all.filter((symbol) => symbol.name.toLowerCase().includes(query)),
      });
      return;
    }
    default:
      if (message.id !== undefined)
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'unsupported method' },
        });
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf(SEPARATOR);
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const bodyStart = headerEnd + SEPARATOR.length;
    const length = Number(match[1]);
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body) as Incoming);
  }
});
