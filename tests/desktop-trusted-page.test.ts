import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedPage } from '../apps/desktop/trusted-page.ts';

const root =
  process.platform === 'win32'
    ? 'C:\\Users\\RUNNER~1\\中文 升级目录'
    : '/tmp/RUNNER~1/中文 升级目录';
const page = path.join(root, 'resources', 'app', 'index.html');

test('the desktop trusts its own page however the URL spells a tilde', () => {
  const nodeUrl = pathToFileURL(page).href;
  assert.match(nodeUrl, /%7E/);
  assert.equal(isTrustedPage(nodeUrl, page), true);
  // Chromium keeps the tilde as typed.
  assert.equal(isTrustedPage(nodeUrl.replaceAll('%7E', '~'), page), true);
});

test('the desktop refuses any other page as a sender', () => {
  const url = pathToFileURL(page).href;
  assert.equal(isTrustedPage(`${url}?x=1`, page), false);
  assert.equal(isTrustedPage(`${url}#frame`, page), false);
  assert.equal(isTrustedPage(pathToFileURL(path.join(root, 'other.html')).href, page), false);
  assert.equal(isTrustedPage('https://example.com/index.html', page), false);
  assert.equal(isTrustedPage('not a url', page), false);
});
