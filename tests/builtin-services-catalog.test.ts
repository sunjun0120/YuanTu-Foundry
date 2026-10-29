// tests/builtin-services-catalog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry } from '../packages/protocol/jobs.ts';
import {
  builtinServiceTools,
  closeBuiltinServices,
  warmToolCache,
} from '../packages/builtin-services/index.ts';
import {
  builtinServiceConfigured,
  PRODUCTION_BASE_URL,
  resolveBuiltinService,
} from '../packages/builtin-services/manifest.ts';
import { sharedTasks } from '../packages/builtin-services/tasks.ts';
import { builtinSkills } from '../packages/resources/builtin-skills.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const schema = {
  type: 'object',
  properties: { project_id: { type: 'string' } },
  additionalProperties: false,
};

test('without an address nothing is registered', async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(
    builtinServiceTools(root, 's', new JobRegistry(), { YUANTU_STATE_DIR: root }),
    [],
  );
});

test('a warmed cache registers the backend tools next to upload and download', async (t) => {
  const root = await tempRoot(t);
  const { baseUrl, state } = await analysisServiceFixture(t);
  t.after(() => closeBuiltinServices());
  state.tools = [
    { name: 'license_analyze', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'task_status', inputSchema: schema },
  ];
  const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: baseUrl };
  const before = builtinServiceTools(root, 's', new JobRegistry(), env, 'win32').map(
    (tool) => tool.name,
  );
  assert.deepEqual(before.sort(), ['analysis_download_report', 'analysis_upload_source']);
  await warmToolCache(env);
  const jobs = new JobRegistry();
  const after = builtinServiceTools(root, 's', jobs, env, 'win32').map((tool) => tool.name);
  assert.deepEqual(after.sort(), [
    'analysis_download_report',
    'analysis_upload_source',
    'scan_license_analyze',
  ]);
  assert.deepEqual(jobs.list('s'), [], 'the analysis job producer is registered and empty');
});

test('without secure path leases upload and download are not offered', async (t) => {
  const root = await tempRoot(t);
  const { baseUrl, state } = await analysisServiceFixture(t);
  t.after(() => closeBuiltinServices());
  state.tools = [
    { name: 'license_analyze', inputSchema: schema, annotations: { readOnlyHint: true } },
  ];
  const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: baseUrl };
  await warmToolCache(env);
  const names = builtinServiceTools(root, 's', new JobRegistry(), env, 'darwin').map(
    (tool) => tool.name,
  );
  assert.deepEqual(names, ['scan_license_analyze']);
});

test('a backend schema the registry would reject does not break the catalog', async (t) => {
  const root = await tempRoot(t);
  const { baseUrl, state } = await analysisServiceFixture(t);
  t.after(() => closeBuiltinServices());
  state.tools = [
    // `format` is rejected by the registry's strict Ajv (the tool is skipped with a log line).
    {
      name: 'date_report',
      inputSchema: { type: 'object', properties: { d: { type: 'string', format: 'date-time' } } },
    },
    { name: 'license_analyze', inputSchema: schema, annotations: { readOnlyHint: true } },
  ];
  const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: baseUrl };
  await warmToolCache(env);
  const names = builtinServiceTools(root, 's', new JobRegistry(), env, 'win32').map(
    (tool) => tool.name,
  );
  assert.deepEqual(names.sort(), [
    'analysis_download_report',
    'analysis_upload_source',
    'scan_license_analyze',
  ]);
});

test('a workspace task set follows the service address and is dropped at close', async (t) => {
  const root = await tempRoot(t);
  const client = { callTool: async () => ({ content: [] }) };
  const first = resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:1' })!;
  const moved = resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:2' })!;
  const tasks = sharedTasks(root, first, client);
  assert.equal(sharedTasks(root, first, client), tasks);
  const elsewhere = sharedTasks(root, moved, client);
  assert.notEqual(elsewhere, tasks, 'another address gets its own client, not the old one');
  await closeBuiltinServices();
  assert.notEqual(sharedTasks(root, moved, client), elsewhere, 'close forgets the task sets');
});

test('warming an unreachable service does not throw', async (t) => {
  const root = await tempRoot(t);
  await warmToolCache({
    YUANTU_STATE_DIR: root,
    YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:9',
  });
});

test('the code analysis report skill is built in', () => {
  assert.ok(
    builtinSkills({ analysisService: true }).some((skill) => skill.name === 'code-analysis-report'),
  );
  assert.equal(
    builtinSkills().some((skill) => skill.name === 'code-analysis-report'),
    false,
  );
});

test('the service counts as configured exactly where its tools can be registered', () => {
  assert.equal(builtinServiceConfigured({ YUANTU_BUILTIN_SERVICES: '0' }), false);
  assert.equal(
    builtinServiceConfigured({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:9' }),
    true,
  );
  // An installed app ignores the development override, and an unusable address registers nothing.
  assert.equal(
    builtinServiceConfigured({
      YUANTU_PACKAGED: '1',
      YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:9',
    }),
    PRODUCTION_BASE_URL !== undefined,
  );
  assert.equal(
    builtinServiceConfigured({ YUANTU_BUILTIN_SERVICES_URL: 'http://example.com' }),
    false,
  );
});
