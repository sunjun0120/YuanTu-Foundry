// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture } from './http-fixture.ts';

/**
 * The live bubble and the folds React owns, observed as DOM rather than as text.
 *
 * Two questions are answered here that the behavioural suites cannot:
 *
 * 1. **Identity.** A streaming repaint must update the nodes it already has. The live host and the answer's content
 *    element are captured early and compared by object identity after several deltas — plus a MutationObserver proves
 *    the content element was never removed. A React tree that re-created the bubble would look identical in a
 *    screenshot and lose selection, expansion and scroll position.
 * 2. **The fold's animation.** Opening a fold has to be a visible height ramp whose duration comes from
 *    `motion-tokens.ts`, and with reduced motion it has to be a single paint. Sampling the collapse wrapper per frame
 *    is the only way to tell an animation from an instant jump; a final screenshot cannot.
 *
 * The animation is measured on the stored transcript's process group rather than on the live thinking fold: the live
 * fold lives inside that group while a run is thinking, so its box is clipped by the group it has not opened yet.
 */
const THOUGHT = 'weighing the note file before writing\nsecond line of reasoning';
const GROUP = '#messages > .process-group';
const COLLAPSE = `${GROUP} > div`;

const reduce = (page) => page.emulateMedia({ reducedMotion: 'reduce' });
const allow = (page) => page.emulateMedia({ reducedMotion: 'no-preference' });

/** Click the fold's summary from inside the page and sample the collapse wrapper's height once per frame. */
function sampleOpening(page, selector) {
  return page.evaluate(async (target) => {
    const wrapper = document.querySelector(target);
    const summary = wrapper?.parentElement?.querySelector(':scope > summary');
    const samples = [];
    const start = performance.now();
    summary?.click();
    return await new Promise((resolve) => {
      const tick = () => {
        samples.push({
          at: Math.round(performance.now() - start),
          height: Math.round(wrapper?.getBoundingClientRect().height ?? -1),
        });
        if (performance.now() - start > 700) resolve(samples);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, selector);
}

/** The ramp's start and end, ignoring the frames before the first non-zero height. */
function rampWindow(samples) {
  const final = samples.at(-1)?.height ?? 0;
  const moving = samples.filter((sample) => sample.height > 1 && sample.height < final - 1);
  const full = samples.find((sample) => sample.height >= final - 1);
  return { final, moving, duration: (full?.at ?? 0) - (moving[0]?.at ?? 0) };
}

test(
  'desktop keeps the streaming nodes and animates the folds it owns',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-identity-ui-'));
    const chunks = ['The ', 'note ', 'file ', 'already ', 'exists, ', 'so nothing was written.'];
    const url = await httpFixture(t, async (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n');
      send({
        choices: [
          { index: 0, delta: { reasoning_content: THOUGHT, content: '' }, finish_reason: null },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 2200));
      for (const chunk of chunks) {
        send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 12 } });
      res.end('data: [DONE]\n\n');
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'identity-fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'openai',
      YUANTU_PERMISSION_POLICY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        '--user-data-dir=' + path.join(root, 'profile'),
      ],
      env,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Check the note file');
    await page.locator('#send').click();

    // The thinking fold appears inside the transcript's live group; `#live` itself is the static host.
    await page.waitForFunction(() => document.getElementById('live-reasoning')?.hidden === false);
    await page.evaluate(() => {
      window.__identity = {
        live: document.getElementById('live'),
        thought: document.getElementById('live-reasoning'),
        content: null,
        removedContent: 0,
      };
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes)
            if (node instanceof HTMLElement && node.classList.contains('message-content'))
              window.__identity.removedContent += 1;
      });
      observer.observe(document.getElementById('live'), { childList: true, subtree: true });
    });

    // The answer streams in chunks; its content element must be updated, not replaced.
    await page.waitForFunction(
      () => (document.querySelector('#live .message-content')?.textContent?.length ?? 0) >= 16,
    );
    await page.evaluate(() => {
      window.__identity.content = document.querySelector('#live .message-content');
    });
    await page.waitForFunction(
      () => (document.querySelector('#live .message-content')?.textContent?.length ?? 0) >= 40,
    );
    const identity = await page.evaluate(() => ({
      live: document.getElementById('live') === window.__identity.live,
      thought: document.getElementById('live-reasoning') === window.__identity.thought,
      content: document.querySelector('#live .message-content') === window.__identity.content,
      removedContent: window.__identity.removedContent,
      stillClosed: !(document.getElementById('live-reasoning')?.hasAttribute('open') ?? false),
    }));
    assert.equal(identity.live, true, 'the live host is never replaced');
    assert.equal(identity.thought, true, 'the thinking fold keeps its identity while it streams');
    assert.equal(identity.content, true, 'the answer updates the same content element');
    assert.equal(identity.removedContent, 0, 'no content element was removed and rebuilt');
    assert.equal(
      identity.stillClosed,
      true,
      'the fold starts closed and a repaint does not open it',
    );

    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    await page.locator('#messages .message.assistant .message-content').waitFor();

    // Normal motion: opening the stored group's fold is a visible ramp of the panel duration.
    await allow(page);
    const opening = await sampleOpening(page, COLLAPSE);
    const open = rampWindow(opening);
    assert.ok(
      open.final > 20,
      `the opened fold has height, got ${JSON.stringify(opening.map((s) => s.height))}`,
    );
    assert.ok(
      open.moving.length >= 3,
      `the fold must animate its height, got ${JSON.stringify(opening.map((s) => s.height))}`,
    );
    assert.ok(
      open.duration >= 60 && open.duration <= 420,
      `the ramp takes the panel duration, got ${open.duration}ms`,
    );
    assert.equal(
      await page.locator(GROUP).evaluate((group) => group.open),
      true,
      'an opened fold carries its own open state',
    );

    // Closing is animated too, and the fold only loses `open` when the body has finished collapsing.
    const closing = await sampleOpening(page, COLLAPSE);
    assert.ok(
      (closing.at(-1)?.height ?? -1) <= 1,
      `the closing fold ends at zero height, got ${JSON.stringify(closing.map((s) => s.height))}`,
    );
    const closeRamp = closing.filter(
      (sample) => sample.height > 1 && sample.height < (closing[0]?.height ?? 0) - 1,
    );
    assert.ok(
      closeRamp.length >= 1,
      `closing keeps the body long enough to animate, got ${JSON.stringify(closing.map((s) => s.height))}`,
    );
    await page.waitForFunction(
      (selector) => !document.querySelector(selector)?.hasAttribute('open'),
      GROUP,
    );

    // Reduced motion: the same fold opens in one paint.
    await reduce(page);
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    const snapped = await sampleOpening(page, COLLAPSE);
    const snap = rampWindow(snapped);
    assert.ok(
      snap.final > 20,
      `the reduced-motion fold still opens, got ${JSON.stringify(snapped.map((s) => s.height))}`,
    );
    assert.ok(
      snap.moving.length <= 1,
      `reduced motion must not animate, got ${JSON.stringify(snapped.map((s) => s.height))}`,
    );
  },
);
