// tests/builtin-services-request.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { ServiceRequester } from '../packages/builtin-services/service-request.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';

const requesterFor = (baseUrl: string) =>
  new ServiceRequester(resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!);

test('urls are built under the base address and recognised as the same origin', () => {
  const requester = requesterFor('http://127.0.0.1:4100/api');
  assert.equal(requester.url('/upload'), 'http://127.0.0.1:4100/api/upload');
  assert.equal(requester.sameOrigin('http://127.0.0.1:4100/reports/a.pdf'), true);
  assert.equal(requester.sameOrigin('http://127.0.0.1:4101/reports/a.pdf'), false);
  assert.equal(requester.sameOrigin('not a url'), false);
});

test('phase one sends no authorization header', () => {
  assert.deepEqual(requesterFor('http://127.0.0.1:4100').headers(), {});
});

test('a request to another origin is refused before it is sent', async () => {
  const requester = requesterFor('http://127.0.0.1:4100');
  await assert.rejects(requester.fetch('http://127.0.0.1:4101/x'), /left its origin/);
});

test('a redirect is an error rather than a hop', async (t) => {
  const { baseUrl, state } = await analysisServiceFixture(t);
  state.reports.set('elsewhere.pdf', { type: 'application/pdf', body: Buffer.from('%PDF') });
  await assert.rejects(requesterFor(baseUrl).fetch(`${baseUrl}/redirect`));
});
