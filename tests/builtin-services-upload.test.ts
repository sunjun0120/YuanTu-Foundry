// tests/builtin-services-upload.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../packages/protocol/index.ts';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { ServiceRequester } from '../packages/builtin-services/service-request.ts';
import { planDirectory, uploadSourceTool } from '../packages/builtin-services/upload.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

async function workspace(t: Parameters<typeof tempRoot>[0]) {
  const root = await tempRoot(t);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await mkdir(path.join(root, 'analysis-reports', 'p-1'), { recursive: true });
  await mkdir(path.join(root, 'analysis-inputs'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await writeFile(path.join(root, 'id_rsa'), 'key');
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref');
  await writeFile(path.join(root, 'node_modules', 'x', 'index.js'), '');
  await writeFile(path.join(root, 'source.zip'), Buffer.from('PK\x03\x04fake'));
  await writeFile(path.join(root, 'analysis-reports', 'p-1', 'old.pdf'), '%PDF');
  await writeFile(path.join(root, 'analysis-inputs', 'old.zip'), Buffer.from('PK\x03\x04old'));
  return root;
}

test(
  'a directory plan leaves out VCS, dependencies, credentials and earlier analysis files',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await workspace(t);
    const plan = await planDirectory(root, 1024 * 1024, new AbortController().signal);
    assert.deepEqual(plan.files.map((file) => file.relative.split(path.sep).join('/')).sort(), [
      'package.json',
      'source.zip',
      'src/a.ts',
    ]);
    assert.equal(plan.skipped, 6);
    await assert.rejects(planDirectory(root, 10, new AbortController().signal), /upload limit/);
  },
);

test(
  'an archive uploads as it is and returns the project id',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await workspace(t);
    const { baseUrl, state } = await analysisServiceFixture(t);
    const tool = uploadSourceTool({
      root,
      requester: new ServiceRequester(
        resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
      ),
    });
    assert.equal(tool.permission, 'external');
    const prepared = await tool.prepare!({ path: 'source.zip' }, ctx());
    assert.match(prepared.approvalDescription ?? '', /source\.zip/);
    const result = await prepared.execute(ctx());
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content).project_id, 'p-1');
    assert.equal(state.uploads[0]?.filename, 'source.zip');
    assert.match(state.uploads[0]?.contentType ?? '', /multipart\/form-data/);
  },
);

test(
  'a directory is zipped before upload and the approval says what is sent',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await workspace(t);
    const { baseUrl, state } = await analysisServiceFixture(t);
    const tool = uploadSourceTool({
      root,
      requester: new ServiceRequester(
        resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
      ),
    });
    const prepared = await tool.prepare!({ path: 'src' }, ctx());
    assert.match(prepared.approvalDescription ?? '', /1 files/);
    const result = await prepared.execute(ctx());
    assert.equal(result.isError, false);
    assert.equal(state.uploads[0]?.filename, 'src.zip');
  },
);

test(
  'other files, credential paths and bad replies are refused',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await workspace(t);
    const { baseUrl, state } = await analysisServiceFixture(t);
    const tool = uploadSourceTool({
      root,
      requester: new ServiceRequester(
        resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
      ),
    });
    await assert.rejects(tool.prepare!({ path: 'package.json' }, ctx()), /archives or directories/);
    await assert.rejects(tool.prepare!({ path: '.env' }, ctx()));
    await assert.rejects(tool.prepare!({ path: '../outside' }, ctx()));
    state.uploadReply = { status: 200, body: { nothing: true } };
    const result = await (await tool.prepare!({ path: 'source.zip' }, ctx())).execute(ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /project_id/);
    state.uploadReply = { status: 200, body: { project_id: '../escape' } };
    const escaping = await (await tool.prepare!({ path: 'source.zip' }, ctx())).execute(ctx());
    assert.equal(escaping.isError, true);
    state.uploadReply = { status: 500, body: { message: 'backend exploded: secret detail' } };
    const failed = await (await tool.prepare!({ path: 'source.zip' }, ctx())).execute(ctx());
    assert.equal(failed.isError, true);
    assert.doesNotMatch(failed.content, /secret detail/);
  },
);

test(
  'upload refuses a junction introduced after approval',
  { skip: process.platform !== 'win32' ? 'Windows junction' : false },
  async (t) => {
    const root = await workspace(t);
    const outside = await tempRoot(t);
    await writeFile(path.join(outside, 'a.ts'), 'outside marker');
    const { rename, symlink } = await import('node:fs/promises');
    const { baseUrl, state } = await analysisServiceFixture(t);
    const tool = uploadSourceTool({
      root,
      requester: new ServiceRequester(
        resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
      ),
    });
    const prepared = await tool.prepare!({ path: 'src' }, ctx());
    await rename(path.join(root, 'src'), path.join(root, 'moved'));
    await symlink(outside, path.join(root, 'src'), 'junction');
    await assert.rejects(prepared.execute(ctx()));
    assert.equal(state.uploads.length, 0);
  },
);

test(
  'archive changed after approval is refused',
  { skip: process.platform !== 'win32' ? 'Windows secure path leases required' : false },
  async (t) => {
    const root = await workspace(t);
    const { baseUrl, state } = await analysisServiceFixture(t);
    const tool = uploadSourceTool({
      root,
      requester: new ServiceRequester(
        resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!,
      ),
    });
    const prepared = await tool.prepare!({ path: 'source.zip' }, ctx());
    await writeFile(path.join(root, 'source.zip'), 'changed');
    await assert.rejects(prepared.execute(ctx()), /changed/);
    assert.equal(state.uploads.length, 0);
  },
);
