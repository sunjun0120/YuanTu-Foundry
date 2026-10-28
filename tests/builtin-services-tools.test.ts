// tests/builtin-services-tools.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../packages/protocol/index.ts';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { formatResult, remoteTools, taskStart } from '../packages/builtin-services/remote-tools.ts';

const manifest = resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100' })!;
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
const objectSchema = {
  type: 'object',
  properties: { project_id: { type: 'string' } },
  required: ['project_id'],
  additionalProperties: false,
};

test('backend tools become prefixed native tools; task tools and bad entries are left out', () => {
  const tools = remoteTools(
    { manifest, scope: 's', client: { callTool: async () => ({ content: [] }) } },
    [
      { name: 'license_analyze', inputSchema: objectSchema, annotations: { readOnlyHint: true } },
      { name: 'project_delete', inputSchema: objectSchema },
      { name: 'task_status', inputSchema: objectSchema },
      { name: 'bad name!', inputSchema: objectSchema },
      { name: 'not_object', inputSchema: { type: 'string' } },
      { name: 'license_analyze', inputSchema: objectSchema },
    ],
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['scan_license_analyze', 'scan_project_delete'],
  );
  assert.equal(tools[0]?.permission, undefined);
  assert.equal(tools[1]?.permission, 'external');
  assert.match(tools[1]?.approvalDescription ?? '', /project_delete/);
});

test('the tool count stops at maxTools', () => {
  const catalog = Array.from({ length: 70 }, (_, index) => ({
    name: `t${index}`,
    inputSchema: objectSchema,
  }));
  assert.equal(
    remoteTools(
      { manifest, scope: 's', client: { callTool: async () => ({ content: [] }) } },
      catalog,
    ).length,
    64,
  );
});

test('a schema the registry would reject is skipped, not fatal', () => {
  const tools = remoteTools(
    { manifest, scope: 's', client: { callTool: async () => ({ content: [] }) } },
    [
      // `format` is unknown to the registry's strict Ajv even though a lenient one would compile it.
      {
        name: 'date_report',
        inputSchema: {
          type: 'object',
          properties: { d: { type: 'string', format: 'date-time' } },
        },
      },
      { name: 'license_analyze', inputSchema: objectSchema },
    ],
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['scan_license_analyze'],
  );
});

test('the total schema budget stops the catalog before maxTools does', () => {
  const wide = {
    type: 'object',
    properties: { note: { type: 'string', description: 'x'.repeat(6000) } },
    additionalProperties: false,
  };
  const tools = remoteTools(
    {
      manifest: { ...manifest, maxSchemaBytes: 10_000 },
      scope: 's',
      client: { callTool: async () => ({ content: [] }) },
    },
    [
      { name: 'one', inputSchema: wide },
      { name: 'two', inputSchema: wide },
    ],
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['scan_one'],
  );
});

test('invalid arguments are refused locally without a request', async () => {
  let calls = 0;
  const [tool] = remoteTools(
    { manifest, scope: 's', client: { callTool: async () => (calls++, { content: [] }) } },
    [{ name: 'license_analyze', inputSchema: objectSchema }],
  );
  const result = await tool!.execute({}, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /project_id/);
  assert.equal(calls, 0);
});

test('a service failure reads as unavailable, not as an empty answer', async () => {
  const [tool] = remoteTools(
    {
      manifest,
      scope: 's',
      client: {
        callTool: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    },
    [{ name: 'license_analyze', inputSchema: objectSchema }],
  );
  const result = await tool!.execute({ project_id: 'p-1' }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /unavailable/);
});

test('results keep text, name report links and append structured content', () => {
  const result = formatResult(
    {
      content: [
        { type: 'text', text: 'MIT: 12' },
        {
          type: 'resource_link',
          uri: 'http://127.0.0.1:4100/reports/r.pdf',
          name: 'r.pdf',
          mimeType: 'application/pdf',
        },
      ],
      structuredContent: { mit: 12 },
    } as CallToolResult,
    1024,
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /MIT: 12/);
  assert.match(result.content, /analysis_download_report/);
  assert.match(result.content, /\{"mit":12\}/);
});

test('an oversized result is cut and marked so the registry spills it honestly', () => {
  const result = formatResult(
    { content: [{ type: 'text', text: 'x'.repeat(5000) }] } as CallToolResult,
    1000,
  );
  assert.equal(result.content.length, 1000);
  assert.equal(result.truncated, true);
});

test('a task start is recognised from structured content', () => {
  assert.deepEqual(
    taskStart({
      content: [],
      structuredContent: { task_id: 't-1', status: 'queued' },
    } as CallToolResult),
    { taskId: 't-1' },
  );
  assert.equal(
    taskStart({ content: [], structuredContent: { task_id: 'bad id!' } } as CallToolResult),
    undefined,
  );
  assert.equal(taskStart({ content: [] } as CallToolResult), undefined);
});

test('a task start registers a job and tells the model how to follow it', async () => {
  const started: unknown[] = [];
  const [tool] = remoteTools(
    {
      manifest,
      scope: 'session-1',
      client: {
        callTool: async () => ({
          content: [],
          structuredContent: { task_id: 't-1', status: 'queued' },
        }),
      },
      tasks: { start: (input) => (started.push(input), { id: 'analysis-t-1' }) },
    },
    [{ name: 'vuln_scan', inputSchema: objectSchema }],
  );
  const result = await tool!.execute({ project_id: 'p-1' }, ctx());
  assert.equal(result.isError, false);
  assert.match(result.content, /job_output/);
  assert.match(result.content, /analysis-t-1/);
  assert.deepEqual(started, [
    {
      scope: 'session-1',
      taskId: 't-1',
      tool: 'vuln_scan',
      label: 'vuln_scan {"project_id":"p-1"}',
    },
  ]);
});

test('a task start reports when its recovery record could not be persisted', async () => {
  const [tool] = remoteTools(
    {
      manifest,
      scope: 's',
      client: {
        callTool: async () => ({
          content: [],
          structuredContent: { task_id: 't-1', status: 'queued' },
        }),
      },
      tasks: {
        start: () => ({ id: 'analysis-t-1' }),
        flush: async () => {
          throw new Error('disk full');
        },
      },
    },
    [{ name: 'vuln_scan', inputSchema: objectSchema }],
  );
  const result = await tool!.execute({ project_id: 'p-1' }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /analysis-t-1/);
});
