import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRead, shellReadIn, shellReadNotice } from '../packages/core/tool-advice.ts';
import { toolMisuse } from '../packages/core/tool-misuse.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import type { Message } from '../packages/protocol/index.ts';

test('a command counts as a file read only when every part of it reads', () => {
  assert.equal(shellRead('cat src/a.ts'), 'cat');
  assert.equal(shellRead('grep -rn foo src | head -20'), 'grep');
  assert.equal(shellRead('Get-Content README.md'), 'get-content');
  assert.equal(shellRead('sed -n 1,40p a.ts'), 'sed');
  assert.equal(shellRead('find . -name "*.ts"'), 'find');
  // Something else ran, wrote, or changed a file: no file tool does that.
  assert.equal(shellRead('npm test | grep fail'), undefined);
  assert.equal(shellRead('cat a > b'), undefined);
  assert.equal(shellRead('sed -i s/a/b/ a.ts'), undefined);
  assert.equal(shellRead('find . -name x -delete'), undefined);
  assert.equal(shellRead('cat $(ls)'), undefined);
  assert.equal(shellRead(''), undefined);
  assert.equal(
    shellReadIn([
      { id: '1', name: 'read_file', arguments: { path: 'a' } },
      { id: '2', name: 'run_command', arguments: { command: 'ls -la' } },
    ]),
    'ls',
  );
  assert.ok(isRuntimeContext(shellReadNotice('cat')));
});

test('misuse is counted from the refusal texts the model read', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: '1', name: 'readFile', arguments: {} },
        { id: '2', name: 'read_file', arguments: { file: 'a' } },
        { id: '3', name: 'run_command', arguments: { command: 'cat a' } },
      ],
    },
    { role: 'tool', toolCallId: '1', isError: true, content: 'Unknown tool: readFile.' },
    { role: 'tool', toolCallId: '2', isError: true, content: 'Invalid arguments: x.' },
    {
      role: 'tool',
      toolCallId: '3',
      isError: true,
      content: 'Permission denied by user. Do not retry.',
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '4', name: 'read_file', arguments: { file: 'a' } }],
    },
    { role: 'tool', toolCallId: '4', isError: true, content: 'Invalid arguments: x.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '5', name: 'read_file', arguments: { path: 'a' } }],
    },
    { role: 'tool', toolCallId: '5', isError: false, content: 'ok' },
  ];
  const report = toolMisuse([messages]);
  assert.equal(report.calls, 5);
  assert.equal(report.unknownTool, 1);
  assert.equal(report.invalidArguments, 2);
  assert.equal(report.denied, 1);
  assert.equal(report.repeatedAfterError, 1);
  assert.equal(report.shellReads, 1);
  assert.deepEqual(report.tools[0], { name: 'read_file', calls: 3, failures: 2 });
});
