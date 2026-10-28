// tests/builtin-services-manifest.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';

test('no configured address means no built-in service', () => {
  assert.equal(resolveBuiltinService({}), undefined);
});

test('the feature switch turns the service off even when an address is set', () => {
  assert.equal(
    resolveBuiltinService({
      YUANTU_BUILTIN_SERVICES: '0',
      YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100',
    }),
    undefined,
  );
  assert.ok(
    resolveBuiltinService({
      YUANTU_BUILTIN_SERVICES: '1',
      YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100',
    }),
  );
});

test('a development override sets the base address and keeps the defaults', () => {
  const manifest = resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100/' });
  assert.equal(manifest?.baseUrl, 'http://127.0.0.1:4100');
  assert.equal(manifest?.mcpPath, '/mcp');
  assert.equal(manifest?.uploadPath, '/upload');
  assert.equal(manifest?.toolPrefix, 'scan');
  assert.equal(manifest?.callTimeoutMs, 300_000);
  assert.equal(manifest?.maxSchemaBytes, 256 * 1024);
  assert.deepEqual(manifest?.taskTools, {
    status: 'task_status',
    result: 'task_result',
    cancel: 'task_cancel',
  });
});

test('a path prefix is kept without its trailing slash', () => {
  assert.equal(
    resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'https://scan.example.com/api/' })
      ?.baseUrl,
    'https://scan.example.com/api',
  );
});

test('a packaged build ignores the development override', () => {
  assert.equal(
    resolveBuiltinService({
      YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100',
      YUANTU_PACKAGED: '1',
    }),
    undefined,
  );
});

test('plain http is refused off loopback, and credentials or query are refused anywhere', () => {
  for (const value of [
    'http://scan.example.com',
    'https://user:pass@scan.example.com',
    'https://scan.example.com/?token=1',
    'https://scan.example.com/#x',
    'ftp://scan.example.com',
  ])
    assert.throws(
      () => resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: value }),
      /Built-in service URL/,
    );
});
