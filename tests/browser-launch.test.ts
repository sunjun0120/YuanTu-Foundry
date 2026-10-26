import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserSession } from '../packages/tools/browser.ts';

test('browser launch failures retain their cause instead of suggesting a package install', async (t) => {
  // Keep initialization inside the registered test: earlier tests must not finish before this one is collected.
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (error) {
    if (/Executable doesn't exist/.test(String(error))) return t.skip('chromium is not installed');
    throw error;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-browser-launch-'));
  const profile = path.join(root, 'not-a-directory');
  await writeFile(profile, 'occupied');
  const previousLog = process.env.CHROME_LOG_FILE;
  process.env.CHROME_LOG_FILE = path.join(root, 'chromium.log');
  const session = new BrowserSession({ profileDirectory: profile });
  t.after(async () => {
    if (previousLog === undefined) delete process.env.CHROME_LOG_FILE;
    else process.env.CHROME_LOG_FILE = previousLog;
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    session.use(new AbortController().signal, (page) => page.title()),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Browser launch failed/);
      assert.doesNotMatch(error.message, /npm install playwright/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.message, /not-a-directory/);
      return true;
    },
  );
});
