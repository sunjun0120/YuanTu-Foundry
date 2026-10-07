import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const flags = process.argv.slice(2).filter((value) => value.startsWith('--'));
const stateFile = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (stateFile) writeFileSync(stateFile, String(process.pid));
/** `--tools-only` advertises no resources or prompts so capability gating can be tested. */
const toolsOnly = flags.includes('--tools-only');
const capabilities = toolsOnly
  ? { tools: { listChanged: true } }
  : {
      tools: { listChanged: true },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    };
/**
 * Whether this server has already announced a tool-list change.
 *
 * The `refresh` tool is the trigger rather than a timer: the notification is written to stdout *before* that
 * call's own answer, and a transport reads its lines in order, so a client that has the call's result has the
 * notification too. A test can therefore assert the re-read without racing the pipe.
 */
let refreshed = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'tools/call' && request.params?.name === 'refresh') {
    refreshed = true;
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n',
    );
  }
  const result = (() => {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: '2025-03-26',
          capabilities,
          serverInfo: { name: 'fixture', version: '1' },
          instructions: 'Fixture server instructions.',
        };
      case 'tools/list':
        return {
          tools: [
            {
              name: 'echo',
              description: 'Echo input',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
            {
              name: 'secret',
              description: 'Echo configured secret for redaction test',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              name: 'wait',
              description: 'Wait for cancellation',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              name: 'refresh',
              description: 'Announce a tool-list change from the server side',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            ...(refreshed
              ? [
                  {
                    name: 'added',
                    description: 'Appeared only after the server announced a change',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  },
                ]
              : []),
          ],
        };
      case 'resources/list':
        return {
          resources: [
            {
              uri: 'fixture://readme',
              name: 'readme',
              title: 'Fixture readme',
              mimeType: 'text/plain',
              description: 'Static fixture resource',
            },
            {
              uri: 'fixture://secret',
              name: 'secret',
              mimeType: 'text/plain',
              description: 'Echo configured secret for redaction test',
            },
          ],
        };
      case 'resources/templates/list':
        return {
          resourceTemplates: [
            {
              uriTemplate: 'fixture://item/{id}',
              name: 'item',
              description: 'Parameterised fixture resource',
            },
          ],
        };
      case 'resources/read':
        return {
          contents: [
            request.params.uri === 'fixture://secret'
              ? {
                  uri: request.params.uri,
                  mimeType: 'text/plain',
                  text: process.env.MCP_SECRET,
                }
              : {
                  uri: request.params.uri,
                  mimeType: 'text/plain',
                  text: 'Fixture resource body for ' + request.params.uri,
                },
          ],
        };
      case 'prompts/list':
        return {
          prompts: [
            {
              name: 'greet',
              title: 'Greeting',
              description: 'Render a greeting',
              arguments: [{ name: 'name', description: 'Who to greet', required: true }],
            },
          ],
        };
      case 'prompts/get':
        return {
          description: 'Render a greeting',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: 'Hello ' + (request.params.arguments?.name ?? 'world'),
              },
            },
          ],
        };
      default:
        if (request.params.name === 'wait') return undefined;
        if (request.params.name === 'refresh')
          return { content: [{ type: 'text', text: 'announced' }], isError: false };
        return {
          content: [
            {
              type: 'text',
              // A tool call with no `text` argument (the tools that only exist to be called) answers with its own
              // name rather than `undefined`: a content block with no text is a result the client rejects, which
              // would look like a transport failure rather than the fixture's answer.
              text:
                request.params.name === 'secret'
                  ? process.env.MCP_SECRET
                  : String(request.params.arguments?.text ?? request.params.name),
            },
          ],
          isError: false,
        };
    }
  })();
  if (result)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
