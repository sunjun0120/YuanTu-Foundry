import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { Message, ToolCall } from '../packages/protocol/index.ts';
import {
  latestTurnStart,
  mcpTarget,
  summarizeArgs,
  summaryView,
  turnMcpCalls,
} from '../apps/desktop/ui/panels/summary-model.ts';

/**
 * The summary popover lists the MCP calls of the latest turn. These are the readings it prints: which calls count as
 * MCP, where a turn starts, and how a call without a result reads while the run goes on and after it ends.
 */
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  arguments: args,
});
const assistant = (...toolCalls: ToolCall[]): Message => ({
  role: 'assistant',
  content: '',
  toolCalls,
});
const result = (toolCallId: string, isError = false): Message => ({
  role: 'tool',
  toolCallId,
  content: '',
  isError,
});

test('built-in service calls and configured MCP proxies are MCP; local tools are not', () => {
  assert.deepEqual(mcpTarget(call('1', 'scan_cve_info', { cve_id: 'CVE-2022-0847' })), {
    server: null,
    tool: 'cve_info',
    args: { cve_id: 'CVE-2022-0847' },
  });
  assert.deepEqual(
    mcpTarget(call('2', 'mcp_github_call_tool', { name: 'search', arguments: { q: 'x' } })),
    { server: 'github', tool: 'search', args: { q: 'x' } },
  );
  assert.deepEqual(mcpTarget(call('3', 'mcp_my_docs_list_tools')), {
    server: 'my_docs',
    tool: 'list_tools',
    args: {},
  });
  assert.equal(mcpTarget(call('4', 'read_file', { path: 'a' })), null);
  assert.equal(mcpTarget(call('5', 'scan_')), null);
  assert.equal(mcpTarget(call('6', 'analysis_upload_source')), null);
});

test('a turn starts at the last message a person wrote, not at runtime context', () => {
  const messages: Message[] = [
    { role: 'user', content: 'first' },
    assistant(call('a', 'scan_cve_info')),
    result('a'),
    { role: 'user', content: 'second' },
    { role: 'user', content: '<runtime-context kind="x">snapshot</runtime-context>' },
    assistant(call('b', 'scan_vuln_query')),
  ];
  assert.equal(latestTurnStart(messages), 3);
  assert.deepEqual(
    turnMcpCalls(messages, true).map((item) => item.tool),
    ['vuln_query'],
  );
  assert.equal(latestTurnStart([assistant()]), -1);
});

test('each call reads succeeded, failed, running or interrupted', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    assistant(
      call('a', 'scan_a'),
      call('b', 'scan_b'),
      call('c', 'scan_c'),
      call('d', 'list_files'),
    ),
    result('a'),
    result('b', true),
  ];
  assert.deepEqual(
    turnMcpCalls(messages, true).map((item) => [item.id, item.status]),
    [
      ['a', 'succeeded'],
      ['b', 'failed'],
      ['c', 'running'],
    ],
  );
  assert.equal(turnMcpCalls(messages, false)[2]!.status, 'interrupted');
});

test('arguments read as one short line', () => {
  assert.equal(
    summarizeArgs({ purl: 'pkg:npm/lodash', level: 2, empty: '', none: null }),
    'purl=pkg:npm/lodash level=2',
  );
  assert.equal(summarizeArgs(undefined), '');
  assert.equal(summarizeArgs({ q: 'x'.repeat(300) }).length, 120);
});

test('the view is offered for a session and adds calls still executing', () => {
  assert.equal(summaryView(null).visible, false);
  const snapshot = {
    session: {
      sessionId: 's1',
      running: true,
      messages: [
        { role: 'user', content: 'go' },
        assistant(call('a', 'scan_a')),
        result('a', true),
      ],
      tools: [
        call('a', 'scan_a'),
        call('b', 'mcp_github_call_tool', { name: 'search', arguments: {} }),
      ],
    },
  } as unknown as CarrierSnapshot;
  const view = summaryView(snapshot);
  assert.equal(view.visible, true);
  assert.equal(view.failed, 1);
  assert.deepEqual(
    view.calls.map((item) => [item.server, item.tool, item.status]),
    [
      [null, 'a', 'failed'],
      ['github', 'search', 'running'],
    ],
  );
});

test('a new turn clears earlier calls, including stale entries in the live tool list', () => {
  const snapshot = {
    session: {
      sessionId: 's1',
      running: true,
      messages: [
        { role: 'user', content: 'first' },
        assistant(call('old', 'scan_cve_info')),
        result('old'),
        { role: 'user', content: 'second' },
        { role: 'user', content: '<runtime-context kind="x">snapshot</runtime-context>' },
      ],
      tools: [call('old', 'scan_cve_info')],
    },
  } as unknown as CarrierSnapshot;
  assert.deepEqual(summaryView(snapshot).calls, []);
  snapshot.session.tools.push(call('new', 'scan_vuln_query'));
  assert.deepEqual(
    summaryView(snapshot).calls.map(({ id, status }) => [id, status]),
    [['new', 'running']],
  );
  snapshot.session.messages.push(assistant(call('new', 'scan_vuln_query')), result('new'));
  snapshot.session.tools = [];
  snapshot.session.running = false;
  assert.deepEqual(
    summaryView(snapshot).calls.map(({ id, status }) => [id, status]),
    [['new', 'succeeded']],
  );
  snapshot.session.messages.push({ role: 'user', content: 'third, no tools needed' });
  assert.deepEqual(summaryView(snapshot).calls, []);
});
