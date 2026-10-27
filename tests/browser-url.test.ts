import test from 'node:test';
import assert from 'node:assert/strict';
import { directHttpUrl, resolveBrowserAddress, SEARCH_URL } from '../apps/desktop/browser-url.ts';

test('direct URLs accept only credential-free http and https', () => {
  assert.equal(directHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(directHttpUrl('http://localhost:5173/'), 'http://localhost:5173/');
  for (const value of [
    'file:///C:/x',
    'javascript:alert(1)',
    'data:text/html,x',
    'mailto:a@b.test',
    'https://user:pass@example.com',
    'https://example.com:99999',
    '',
  ])
    assert.equal(directHttpUrl(value), null, value);
});

test('the address bar adds localhost, https and search without throwing', () => {
  assert.equal(resolveBrowserAddress('example.com'), 'https://example.com/');
  assert.equal(resolveBrowserAddress('localhost:5173'), 'http://localhost:5173/');
  assert.equal(resolveBrowserAddress('127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(resolveBrowserAddress('[::1]:3000'), 'http://[::1]:3000/');
  assert.equal(resolveBrowserAddress('hello world'), `${SEARCH_URL}hello%20world`);
  for (const value of ['example.com:99999', '999.999.999.999', '[::::]', 'file:///C:/x'])
    assert.equal(resolveBrowserAddress(value), null, value);
  assert.equal(resolveBrowserAddress('   '), null);
});
