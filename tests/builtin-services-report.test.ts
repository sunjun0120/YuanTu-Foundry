// tests/builtin-services-report.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../packages/protocol/index.ts';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { ServiceRequester } from '../packages/builtin-services/service-request.ts';
import { downloadReportTool } from '../packages/builtin-services/report.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  /** The stub is what proves the returned change carries its journal id, which is what undo is keyed by. */
  fileJournal: { prepare: () => 'journal-1', applied: () => {} },
});

async function setup(t: Parameters<typeof tempRoot>[0]) {
  const root = await tempRoot(t);
  const { baseUrl, state } = await analysisServiceFixture(t);
  const tool = downloadReportTool({
    root,
    requester: new ServiceRequester(
      resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
    ),
  });
  return { root, baseUrl, state, tool };
}

test(
  'a linked report is saved under analysis-reports and recorded as a new file',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const { root, baseUrl, state, tool } = await setup(t);
    state.reports.set('summary.pdf', {
      type: 'application/pdf',
      body: Buffer.from('%PDF-1.7 body'),
    });
    assert.equal(tool.permission, 'write');
    const prepared = await tool.prepare!(
      { url: `${baseUrl}/reports/summary.pdf`, project_id: 'p-1' },
      ctx(),
    );
    assert.equal(prepared.change?.path, 'analysis-reports/p-1/summary.pdf');
    assert.equal(prepared.change?.kind, 'create');
    const result = await prepared.execute(ctx());
    assert.equal(result.isError, false);
    assert.equal(result.change?.id, 'journal-1');
    assert.deepEqual(JSON.parse(result.content), {
      path: 'analysis-reports/p-1/summary.pdf',
      bytes: 13,
      type: 'application/pdf',
    });
    assert.equal(
      await readFile(path.join(root, 'analysis-reports', 'p-1', 'summary.pdf'), 'utf8'),
      '%PDF-1.7 body',
    );
  },
);

test(
  'links off the service origin, bad project ids and existing files are refused',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const { baseUrl, state, tool } = await setup(t);
    await assert.rejects(
      tool.prepare!({ url: 'https://evil.example/r.pdf', project_id: 'p-1' }, ctx()),
      /service/,
    );
    await assert.rejects(
      tool.prepare!({ url: `${baseUrl}/reports/r.pdf`, project_id: '../x' }, ctx()),
    );
    state.reports.set('r.pdf', { type: 'application/pdf', body: Buffer.from('%PDF') });
    const url = `${baseUrl}/reports/r.pdf`;
    assert.equal(
      (await (await tool.prepare!({ url, project_id: 'p-1' }, ctx())).execute(ctx())).isError,
      false,
    );
    assert.equal(
      (await (await tool.prepare!({ url, project_id: 'p-1' }, ctx())).execute(ctx())).isError,
      true,
    );
  },
);

test(
  'an unexpected type or a name that does not match the type is refused',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const { baseUrl, state, tool } = await setup(t);
    state.reports.set('run.exe', { type: 'application/octet-stream', body: Buffer.from('MZ') });
    state.reports.set('fake.pdf', { type: 'text/html', body: Buffer.from('<html>') });
    for (const name of ['run.exe', 'fake.pdf']) {
      const result = await (
        await tool.prepare!({ url: `${baseUrl}/reports/${name}`, project_id: 'p-1' }, ctx())
      ).execute(ctx());
      assert.equal(result.isError, true, name);
    }
  },
);

test(
  'a report directory junction cannot create anything outside the workspace',
  { skip: process.platform !== 'win32' ? 'Windows junction' : false },
  async (t) => {
    const { root, baseUrl, state, tool } = await setup(t);
    const outside = await tempRoot(t);
    const { symlink, stat } = await import('node:fs/promises');
    await symlink(outside, path.join(root, 'analysis-reports'), 'junction');
    state.reports.set('r.pdf', { type: 'application/pdf', body: Buffer.from('%PDF') });
    const prepared = await tool.prepare!(
      { url: `${baseUrl}/reports/r.pdf`, project_id: 'p-1' },
      ctx(),
    );
    await assert.rejects(prepared.execute(ctx()));
    await assert.rejects(stat(path.join(outside, 'p-1')), { code: 'ENOENT' });
  },
);
