import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileTools, Workspace } from '../packages/tools/files.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { buildRepoMap } from '../packages/tools/repo-map.ts';
import { prepareSandbox } from '../packages/tools/sandbox.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const credentials = [
  '.env',
  '.env.production',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'Credentials.json',
  'credentials.ts',
  'id_rsa',
  'ID_ED25519',
  'private.pem',
  'private.p12',
  'private.pfx',
  'private.key',
];
const marker = 'FAKE_CREDENTIAL_AUDIT_MARKER';
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-credential-paths-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('yuantu-credential-paths-'));
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  for (const tool of fileTools(root)) tools.register(tool);
  t.after(() => tools.close());
  return { root, tools };
}

test('file reads reject credential names at every workspace depth without returning their contents', async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'nested'));
  const leaked: string[] = [];
  for (const name of credentials) {
    const relative = `nested/${name}`;
    await writeFile(path.join(root, relative), marker);
    const result = await tools.execute(
      { id: name, name: 'read_file', arguments: { path: relative } },
      context(),
    );
    if (!result.isError || result.content.includes(marker)) leaked.push(name);
  }
  assert.deepEqual(leaked, [], 'credential files must be refused before reading');
});

test('listing, search and repository outlines omit credential files and directories', async (t) => {
  const { root, tools } = await fixture(t);
  for (const name of credentials)
    await writeFile(path.join(root, name), `export const ${marker} = 1;`);
  await mkdir(path.join(root, 'credentials.yaml'));
  await writeFile(path.join(root, 'credentials.yaml', 'hidden.ts'), `export const ${marker} = 1;`);
  await writeFile(path.join(root, 'safe.ts'), 'export const publicValue = 1;');
  const listed = await new Workspace(root).walk('.', context());
  assert.ok(listed.includes('safe.ts'));
  assert.deepEqual(
    listed.filter((file) => credentials.includes(file) || file.startsWith('credentials.yaml/')),
    [],
  );
  const searched = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: marker } },
    context(),
  );
  assert.equal(searched.isError, false);
  assert.ok(!searched.content.includes(marker), 'search must not expose credential contents');
  assert.deepEqual(
    buildRepoMap(root).files.map((file) => file.path),
    ['safe.ts'],
  );
});

test('credential mutations are rejected before approval and have no filesystem effect', async (t) => {
  const { root, tools } = await fixture(t);
  let approvals = 0;
  const result = await tools.execute(
    { id: 'write', name: 'write_file', arguments: { path: 'private.key', content: marker } },
    {
      ...context(),
      approve: async () => {
        approvals++;
        return true;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(approvals, 0);
  await assert.rejects(readFile(path.join(root, 'private.key')), { code: 'ENOENT' });
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', '.npmrc'), marker);
  await writeFile(path.join(root, 'safe.txt'), 'ordinary content');
  const calls = [
    {
      name: 'edit_file',
      arguments: { path: 'nested/.npmrc', old_text: marker, new_text: 'changed' },
    },
    { name: 'delete_file', arguments: { path: 'nested/.npmrc' } },
    { name: 'move_file', arguments: { from: 'safe.txt', to: 'nested/.netrc' } },
  ];
  for (const call of calls) {
    const denied = await tools.execute(
      { id: call.name, ...call },
      {
        ...context(),
        approve: async () => {
          approvals++;
          return true;
        },
      },
    );
    assert.equal(denied.isError, true);
    assert.match(denied.content, /credential paths/i);
  }
  assert.equal(approvals, 0);
  assert.equal(await readFile(path.join(root, 'nested', '.npmrc'), 'utf8'), marker);
  assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'ordinary content');
  await assert.rejects(readFile(path.join(root, 'nested', '.netrc')), { code: 'ENOENT' });
});

test('spill output access does not bypass credential protection for descendants', async (t) => {
  const { root, tools } = await fixture(t);
  const spill = path.join(root, '.yuantu', 'spill');
  await mkdir(spill, { recursive: true });
  await writeFile(path.join(spill, 'output.txt'), 'PUBLIC_SPILL_OUTPUT');
  await writeFile(path.join(spill, 'private.pem'), marker);
  await mkdir(path.join(spill, 'credentials.json'));
  await writeFile(path.join(spill, 'credentials.json', 'hidden.txt'), marker);
  const safe = await tools.execute(
    { id: 'safe', name: 'read_file', arguments: { path: '.yuantu/spill/output.txt' } },
    context(),
  );
  assert.equal(safe.isError, false, safe.content);
  assert.match(safe.content, /PUBLIC_SPILL_OUTPUT/);
  for (const file of ['private.pem', 'credentials.json/hidden.txt']) {
    const result = await tools.execute(
      { id: file, name: 'read_file', arguments: { path: `.yuantu/spill/${file}` } },
      context(),
    );
    assert.equal(result.isError, true, 'spill exception must only permit the internal directory');
    assert.ok(!result.content.includes(marker));
  }
});

test('container preflight still refuses credential files while public keys and ordinary sources remain accessible', async (t) => {
  const { root, tools } = await fixture(t);
  for (const [index, name] of credentials.entries()) {
    const directory = path.join(root, `case-${index}`);
    await mkdir(directory);
    await writeFile(path.join(directory, name), marker);
    await assert.rejects(
      prepareSandbox(directory, directory, 'echo audit', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /sensitive workspace file/i,
    );
  }
  for (const name of ['id_rsa.pub', 'ordinary.ts']) {
    await writeFile(path.join(root, name), 'PUBLIC_AUDIT_MARKER');
    const result = await tools.execute(
      { id: name, name: 'read_file', arguments: { path: name } },
      context(),
    );
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /PUBLIC_AUDIT_MARKER/);
  }
  const publicRoot = path.join(root, 'public');
  await mkdir(publicRoot);
  await writeFile(path.join(publicRoot, '.env.example'), 'PLACEHOLDER=example');
  const plan = await prepareSandbox(publicRoot, publicRoot, 'echo audit', undefined, {
    mode: 'docker',
    image: 'node:24-bookworm-slim',
  });
  assert.equal(plan.backend, 'docker');
  const publicWorkspace = new Workspace(publicRoot);
  await assert.rejects(publicWorkspace.read('.env.example'), /credential paths/i);
  assert.deepEqual(await publicWorkspace.walk('.', context()), []);
  const exampleSearch = await tools.execute(
    { id: 'example-search', name: 'search_files', arguments: { query: 'PLACEHOLDER=example' } },
    context(),
  );
  assert.equal(exampleSearch.isError, false);
  assert.ok(!exampleSearch.content.includes('PLACEHOLDER=example'));
  for (const [index, name] of ['store.sqlite', 'store.sqlite3', 'store.DB'].entries()) {
    const directory = path.join(root, `database-${index}`);
    await mkdir(directory);
    await writeFile(path.join(directory, name), 'DATABASE_FIXTURE');
    assert.equal(await new Workspace(directory).read(name), 'DATABASE_FIXTURE');
    await assert.rejects(
      prepareSandbox(directory, directory, 'echo audit', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /sensitive workspace file/i,
    );
  }
});
