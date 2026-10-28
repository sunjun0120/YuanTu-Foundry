// tests/builtin-services-flow.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../packages/protocol/index.ts';
import { JobRegistry } from '../packages/protocol/jobs.ts';
import { AnalysisClient } from '../packages/builtin-services/client.ts';
import {
  builtinServiceTools,
  closeBuiltinServices,
  warmToolCache,
} from '../packages/builtin-services/index.ts';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { ServiceRequester } from '../packages/builtin-services/service-request.ts';
import { AnalysisTasks, sharedTasks } from '../packages/builtin-services/tasks.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
const schema = {
  type: 'object',
  properties: { project_id: { type: 'string' } },
  required: ['project_id'],
  additionalProperties: false,
};

test(
  'upload, sync analysis, async analysis, cancel, restart and report download run end to end',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await tempRoot(t);
    await writeFile(path.join(root, 'repo.zip'), Buffer.from('PK\x03\x04fake'));
    const { baseUrl, state } = await analysisServiceFixture(t);
    t.after(() => closeBuiltinServices());
    state.tools = [
      { name: 'license_analyze', inputSchema: schema, annotations: { readOnlyHint: true } },
      { name: 'vuln_scan', inputSchema: schema, annotations: { readOnlyHint: true } },
    ];
    let polls = 0;
    let started = 0;
    const calls: string[] = [];
    state.reports.set('p-1-sbom.json', {
      type: 'application/vnd.cyclonedx+json',
      body: Buffer.from('{"bomFormat":"CycloneDX"}'),
    });
    state.call = (name) => {
      calls.push(name);
      if (name === 'license_analyze')
        return {
          content: [
            { type: 'text', text: 'MIT: 12, GPL-3.0: 1' },
            {
              type: 'resource_link',
              uri: `${baseUrl}/reports/p-1-sbom.json`,
              name: 'p-1-sbom.json',
            },
          ],
        };
      if (name === 'vuln_scan')
        return {
          content: [],
          structuredContent: { task_id: `t-${++started}`, status: 'queued' },
        };
      if (name === 'task_status')
        return {
          content: [],
          structuredContent: { status: ++polls > 1 ? 'completed' : 'running' },
        };
      if (name === 'task_result')
        return { content: [{ type: 'text', text: 'CVE-2024-0001 high' }] };
      return { content: [{ type: 'text', text: 'cancelled' }] };
    };
    const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: baseUrl };
    await warmToolCache(env);
    const jobs = new JobRegistry();
    const tools = new Map(
      builtinServiceTools(root, 'session-1', jobs, env).map((tool) => [tool.name, tool]),
    );

    const upload = await (
      await tools.get('analysis_upload_source')!.prepare!({ path: 'repo.zip' }, ctx())
    ).execute(ctx());
    const projectId = JSON.parse(upload.content).project_id;
    assert.equal(projectId, 'p-1');

    const license = await tools
      .get('scan_license_analyze')!
      .execute({ project_id: projectId }, ctx());
    assert.match(license.content, /GPL-3.0: 1/);

    // The first asynchronous task runs to completion through `job_output`.
    const first = await tools.get('scan_vuln_scan')!.execute({ project_id: projectId }, ctx());
    assert.match(first.content, /analysis-t-1/);
    assert.deepEqual(
      jobs.list('session-1').map((job) => job.id),
      ['analysis-t-1'],
    );
    const done = await jobs.output({
      id: 'analysis-t-1',
      scope: 'session-1',
      cursor: 0,
      waitMs: 30_000,
    });
    assert.equal(done.status, 'completed');
    assert.match(done.output, /CVE-2024-0001/);

    // The second one is cancelled through the same job vocabulary, once.
    const second = await tools.get('scan_vuln_scan')!.execute({ project_id: projectId }, ctx());
    assert.match(second.content, /analysis-t-2/);
    assert.equal((await jobs.kill({ id: 'analysis-t-2', scope: 'session-1' })).status, 'cancelled');
    assert.equal(calls.filter((name) => name === 'task_cancel').length, 1);

    // Host restart: records are read back from the workspace file and answered without touching the backend. The
    // writer coalesces, so wait for the newest snapshot first; a second `sharedTasks` call returns the same record set.
    await sharedTasks(root, resolveBuiltinService(env)!, {
      callTool: async () => ({ content: [] }),
    }).flush();
    const taskFile = path.join(root, '.yuantu', 'analysis-tasks.json');
    const persisted = JSON.parse(await readFile(taskFile, 'utf8')) as {
      id: string;
      status: string;
    }[];
    assert.deepEqual(
      persisted.map((record) => [record.id, record.status]),
      [
        ['analysis-t-1', 'completed'],
        ['analysis-t-2', 'cancelled'],
      ],
    );
    const restartedClient = new AnalysisClient(new ServiceRequester(resolveBuiltinService(env)!));
    t.after(() => restartedClient.close());
    const restarted = new AnalysisTasks({
      file: taskFile,
      manifest: resolveBuiltinService(env)!,
      client: restartedClient,
      sleep: async () => {},
    });
    const remembered = await restarted
      .jobProducer()
      .output({ id: 'analysis-t-1', scope: 'session-1', cursor: 0, waitMs: 0 });
    assert.equal(remembered.status, 'completed');
    assert.match(remembered.output, /CVE-2024-0001/);

    const report = await (
      await tools.get('analysis_download_report')!.prepare!(
        { url: `${baseUrl}/reports/p-1-sbom.json`, project_id: projectId },
        ctx(),
      )
    ).execute(ctx());
    assert.equal(JSON.parse(report.content).path, 'analysis-reports/p-1/p-1-sbom.json');
  },
);
