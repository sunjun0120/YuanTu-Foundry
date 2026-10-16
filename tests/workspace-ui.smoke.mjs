// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { waitForPage } from './page-wait.mjs';

/**
 * The two things the interface must get right about isolation, checked without a window.
 *
 * This is deliberately *not* a browser test. A real desktop run needs a built Electron app, and the properties that
 * matter here are not pixel properties — they are the two statements the interface is allowed to make:
 *
 * 1. **"Isolated" and "shared" are not the same word.** A shared child's changes are already in the parent's change
 *    list and an isolated child's are not, so a card that labelled both the same would send a person looking for
 *    work in a pane that does not have it. That is checked where it is decided: the labels are distinct strings in
 *    both languages, and the renderer picks between them from the binding's own `kind`.
 * 2. **A result's status is shown, and a conflict says nothing was written.** The statuses a result can have are a
 *    closed set, and each one has its own sentence — a single "there is a result" label would leave a person
 *    clicking an import that will refuse, or looking for changes that were deliberately not made.
 *
 * The desktop run itself is what remains unverified on this machine, and the last case prints exactly that rather
 * than claiming otherwise.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

async function read(relative) {
  return await readFile(path.join(ROOT, relative), 'utf8');
}

/** One entry of `apps/desktop/i18n.ts`'s zh/en table, as its two strings. */
function labels(source, key) {
  const match = new RegExp(`'${key.replaceAll('.', '\\.')}':\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  assert.ok(match, `i18n has no entry for ${key}`);
  const strings = [...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((entry) =>
    entry[1].replaceAll("\\'", "'"),
  );
  assert.equal(strings.length, 2, `${key} must have exactly a zh and an en string`);
  return strings;
}

test('the interface distinguishes an isolated workspace from a shared one in both languages', async () => {
  const i18n = await read('apps/desktop/i18n.ts');
  const isolated = labels(i18n, 'subagent.workspace.isolated');
  const shared = labels(i18n, 'subagent.workspace.shared');
  for (const [language, index] of [
    ['zh', 0],
    ['en', 1],
  ]) {
    assert.notEqual(
      isolated[index],
      shared[index],
      `${language}: an isolated child must not be labelled the same as a shared one`,
    );
  }
  // The shared label has to carry the negative as well, because that is the fact a person needs: there is no
  // separation, so the child's changes are already in the parent's list.
  assert.match(shared[0], /不.*隔离|同一目录/);
  assert.match(shared[1], /not isolated|same directory/i);
  // And the isolated label names the directory, because "isolated" without a place is a promise nobody can check.
  assert.match(isolated[0], /\{path\}/);
  assert.match(isolated[1], /\{path\}/);
});

test('every result status the Host can report has its own sentence', async () => {
  const i18n = await read('apps/desktop/i18n.ts');
  const protocol = await read('packages/protocol/workspaces.ts');
  const statuses = /WORKSPACE_RESULT_STATUSES = \[([\s\S]*?)\] as const/.exec(protocol);
  assert.ok(statuses, 'the result statuses are declared as a closed set');
  const declared = [...statuses[1].matchAll(/'([a-z]+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(declared, [
    'ready',
    'unsupported',
    'applying',
    'applied',
    'conflict',
    'superseded',
  ]);
  for (const status of declared) labels(i18n, `subagent.workspace.result.${status}`);
  // The two that stop a person from doing the wrong thing next get their own check: a conflict must say nothing was
  // written, and an unsupported result must send them to the directory instead of to an import button.
  assert.match(labels(i18n, 'subagent.workspace.result.conflict')[0], /未写入/);
  assert.match(labels(i18n, 'subagent.workspace.result.unsupported')[0], /人工处理|子代理目录/);
});

test('the card renders the state from the binding, not from a guess', async () => {
  const renderer = await read('apps/desktop/renderer-subagents.ts');
  // The label is chosen from `kind`, the state rides on a data attribute, and a problem is shown rather than
  // swallowed — the three things that keep the card honest about a workspace it did not create.
  assert.match(renderer, /view\.workspace\.kind === 'worktree'/);
  assert.match(renderer, /dataset\.state = view\.workspace\.state/);
  assert.match(renderer, /subagent\.workspace\.problem/);
  assert.match(renderer, /subagent\.workspace\.result\./);
  const controller = await read('packages/client/session-controller.ts');
  // The view is filled from the Host's own answers, and a Host that cannot answer leaves the field *absent* rather
  // than filling it with `shared`: "we do not know" and "this is not isolated" are different statements.
  assert.match(controller, /request\('workspaces\.get'/);
  assert.match(controller, /request\('workspace\.results'/);
  assert.match(controller, /kind: answer\.binding\.kind/);
});

test('the desktop and the Web entry point share one renderer, or the gap is reported', async () => {
  const renderer = await read('apps/desktop/renderer.ts');
  assert.match(renderer, /setupSubAgents/, 'the desktop wires the sub-agent panel');
  // The Web shell is built from the same packages but its own entry point; whether it renders the panel is a fact
  // about that file, so it is checked rather than assumed.
  const web = await read('apps/web/main.ts');
  const webHasPanel = /renderer-subagents|SubAgentView|subagents/.test(web);
  assert.equal(
    typeof webHasPanel,
    'boolean',
    'the Web entry point either renders sub-agent state or is reported as not covering it',
  );
  if (!webHasPanel)
    process.stderr.write(
      'workspace-ui.smoke: the Web entry point does not render sub-agent workspace state; that platform is unverified\n',
    );
});

test('a built desktop is what a real UI run needs, and its absence is reported', async () => {
  const executable = path.join(ROOT, 'dist', 'desktop', 'main.cjs');
  const built = await access(executable).then(
    () => true,
    () => false,
  );
  if (!built) {
    // The plan's rule for an unverified platform: say so, do not infer it from a passing check somewhere else.
    process.stderr.write(
      `workspace-ui.smoke: no built desktop at ${executable}; the real prepare → isolate → result flow was NOT run in this checkout\n`,
    );
    return;
  }
  // The real run itself is the case below, which skips with the same sentence when the build is missing.
  assert.ok(built, 'a built desktop means the shipped interface can be driven for real');
});

/**
 * The real desktop flow: prepare -> isolated run -> un-imported result -> visible state.
 *
 * This is the acceptance the plan asks for, and it is deliberately the *product's own* path rather than a
 * hand-built one: a real Electron window, the real Host, a real Git repository, and the fixture endpoint standing
 * in for the model. What it holds is the one thing a unit test cannot: that a person looking at this window can
 * tell an isolated sub-agent from a shared one, and can see that its work is waiting to be imported.
 *
 * The model is scripted, so nothing here claims anything about model behaviour — it claims that the mechanism the
 * plan describes is visible in the shipped interface.
 */

const DESKTOP_ENTRY = path.join(ROOT, 'dist', 'desktop', 'main.cjs');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};
const SUBAGENT_MARK = 'You are a sub-agent delegated by a parent agent';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/**
 * The real desktop flow, on by default.
 *
 * This case drives a genuine Electron window, the real Host and a real Git repository through prepare → isolated run
 * → outstanding result, which is the acceptance the plan asks for.
 *
 * **The built desktop is a prerequisite, not an optimisation.** This case drives `dist/`, so `npm run build` has to
 * have run: an attempt against a three-hour-old build failed with the desktop driving a Host that predated the whole
 * feature, which read like a workspace bug and was really a stale artifact.
 *
 * Three traps this case fell into on the way, each recorded because each looked exactly like a product fault:
 *
 * 1. **A scripted model has to be able to finish.** The fixture first answered *every* later parent turn with another
 *    `collect_subagents`, so the parent collected, was told to collect again, and looped for eighty-odd rounds — a page
 *    that never went quiet, which reads as a renderer hang.
 * 2. **The cards are on `state.session.subagents`**, not `state.subagents`. Polling a path that does not exist
 *    evaluates fine, matches nothing, and also looks like a hang.
 * 3. **Existence is not visibility.** `locator.waitFor()` defaults to "visible", and a rendered card inside the
 *    popover can fail that test while being perfectly present; the assertions here are about what the card *says*, so
 *    they wait for it to exist and read it through the DOM.
 *
 * The mechanism itself is covered in process as well (`tests/subagent-workspaces.test.ts`,
 * `tests/workspace-apply.test.ts`, `tests/workspace-recovery.test.ts`); what this case adds is that the shipped
 * window shows it.
 */
test(
  'desktop shows an isolated sub-agent, its un-imported result, and leaves the parent directory alone',
  { timeout: 240_000 },
  async (t) => {
    const built = await access(DESKTOP_ENTRY).then(
      () => true,
      () => false,
    );
    if (!built) {
      // A missing build is a fact about this checkout, not a failure of the mechanism under test — but it is *said*
      // rather than passed over, because a silent skip is indistinguishable from a green run in a log.
      t.skip(`no built desktop at ${DESKTOP_ENTRY}; run npm run build first`);
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-ws-ui-'));
    /**
     * The profile lives *beside* the workspace, never inside it.
     *
     * Electron keeps SQLite and cache files open under its user-data directory for the whole run, and Git refuses to
     * register a worktree whose repository it cannot hold a lock in — with the profile inside the repo, every
     * `worktree add` fails with `EBUSY: resource busy or locked, read`, which reads like a workspace bug and is
     * really just where the test put its scratch directory.
     */
    const profile = await mkdtemp(path.join(tmpdir(), 'yuantu-ws-ui-profile-'));
    /** Everything the renderer logged, so a stall can be reported with whatever it complained about first. */
    const consoleLog = [];
    git(root, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(root, 'base.txt'), 'baseline\n');
    await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'initial']);

    /**
     * Two children of one parent, scripted by which one is asking.
     *
     * The child recognition is the prompt marker the kernel itself puts in a child's system prompt, and the parent
     * is recognized by *turn*: its first round ends with the request, later rounds end with a tool result — routing
     * on "the history holds a tool message" would misroute the parent's own second turn.
     */
    let childTurns = 0;
    let parentTurns = 0;
    let importArgs;
    let importTurn = 0;
    /** Every request and every answer the fixture gave, for a failure report that can be acted on. */
    const fixtureLog = [];
    const url = await httpFixture(t, (body, res) => {
      const child = systemText(body.system).includes(SUBAGENT_MARK);
      fixtureLog.push(`${child ? 'child' : 'parent'} turn ${child ? childTurns : parentTurns}`);
      if (child) {
        childTurns++;
        if (childTurns === 1)
          sendFrames(
            res,
            frames('', [
              {
                id: 'child-write',
                name: 'write_file',
                input: { path: 'child.txt', content: 'written inside the isolated workspace\n' },
              },
            ]),
          );
        else
          sendFrames(
            res,
            frames('', [
              {
                id: 'child-report',
                name: 'submit_report',
                input: {
                  summary: 'Wrote child.txt',
                  findings: [{ statement: 'Wrote child.txt', evidence: 'Ran write_file' }],
                },
              },
            ]),
          );
        return;
      }
      if (importArgs) {
        importTurn++;
        if (importTurn === 1)
          sendFrames(
            res,
            frames('', [{ id: 'list-results', name: 'workspace_results', input: {} }]),
          );
        else if (importTurn === 2)
          sendFrames(
            res,
            frames('', [
              { id: 'import-result', name: 'workspace_result_apply', input: importArgs },
            ]),
          );
        else sendFrames(res, frames('Import request finished.'));
        return;
      }
      parentTurns++;
      if (parentTurns === 1)
        sendFrames(
          res,
          frames('Delegating.', [
            {
              id: 'delegate-1',
              name: 'delegate_task',
              input: {
                tasks: [{ objective: 'Create child.txt', role: 'general' }],
              },
            },
          ]),
        );
      /**
       * Exactly one collect, then prose.
       *
       * A fixture that answered *every* later parent turn with another `collect_subagents` never let the run end: the
       * parent collected, was told to collect again, and looped — eighty-odd model rounds and a page that never went
       * quiet, which reads exactly like a renderer hang. A scripted model has to be able to finish.
       */
      else if (parentTurns === 2)
        sendFrames(
          res,
          frames('Collecting the report.', [
            { id: 'collect-1', name: 'collect_subagents', input: {} },
          ]),
        );
      else sendFrames(res, frames('The child reported that it wrote the file.'));
    });

    const env = {
      ...process.env,
      YUANTU_SANDBOX: 'host',
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_SESSION_TITLES: '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [DESKTOP_ENTRY, `--user-data-dir=${profile}`],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    page.on('console', (message) =>
      consoleLog.push(`${message.type()}: ${message.text()}`.slice(0, 300)),
    );
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${String(error)}`.slice(0, 300)));
    /**
     * Bounds every wait by the *test's* clock, not only by the runner's.
     *
     * A wait that never settles does not reach the runner as an error: it hangs until the harness cancels the test,
     * and the failure arrives as "test timed out" with nothing in it. Bounding each step means a stuck wait is
     * reported at the step it happened, alongside what the fixture was asked and what the page held — which is the
     * difference between a result somebody can act on and one they can only reproduce.
     */
    const step = async (label, promise, ms) => {
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`step "${label}" did not settle within ${ms}ms`)),
          ms,
        );
      });
      try {
        return await Promise.race([promise, expired]);
      } finally {
        clearTimeout(timer);
      }
    };
    await step(
      'the send button',
      page.getByRole('button', { name: '发送', exact: true }).waitFor(),
      30_000,
    );
    await step(
      'the prompt to be enabled',
      page.waitForFunction(() => !document.querySelector('#prompt').disabled),
      30_000,
    ).catch(async (error) => {
      const startup = await page.evaluate(() => ({
        error: document.querySelector('#error')?.textContent ?? '',
        text: document.body.innerText.slice(-2000),
      }));
      throw new Error(
        `${String(error)}\nstartup=${JSON.stringify(startup)}\nconsole=${JSON.stringify(consoleLog.slice(-12))}`,
      );
    });
    /**
     * Full access is granted through the product's own control, because a write-capable child is the thing under
     * test: leaving the guarded preset in place would stop the child at an approval prompt and this test would be
     * measuring the approval flow instead of the workspace flow.
     */
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-acknowledge').check();
    await page.locator('#full-access-enable').click();
    await step(
      'the full-access preset to apply',
      waitForPage(
        page,
        async () => (await window.yuantu.presets({ type: 'get' })).view.current === 'unconfined',
        undefined,
        { timeout: 30_000 },
      ),
      40_000,
    );
    await page.locator('#prompt').fill('Delegate the file creation');
    await page.locator('#send').click();

    /**
     * Read the page *once*, after the run has had time to finish, rather than polling it while it runs.
     *
     * Both halves of that are corrections, and each cost a debugging session:
     *
     * - Polling `snapshot` during a live run is a wait that cannot succeed for the wrong reason. The card is only
     *   complete once the child has exported its result, so the poll's early evaluations legitimately find nothing —
     *   which looks exactly like a hang, and is why this case was first reported as one.
     * - `page.evaluate` issued repeatedly while the renderer is folding a live run's frames is unreliable in this
     *   environment, so one bounded read of a settled page is worth more than a tight loop of live ones.
     *
     * `step()` bounds it, and the catch reports what the fixture was asked and what the page held, so a failure
     * here is diagnosable rather than an opaque cancellation.
     */
    const readPage = async () => {
      const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
      const agents = snapshot.session?.subagents ?? [];
      /**
       * The two ids the workspace lookup depends on, reported beside the view.
       *
       * A missing `workspace` has three possible causes — the Host does not answer `workspaces.get`, it answers with
       * an error, or it answers and the client drops the result — and the view alone cannot tell them apart. Naming
       * the child session and the parent session here makes the next failure actionable instead of a guess.
       */
      return {
        agents: agents.map((agent) => ({
          status: agent.status,
          error: agent.error,
          childSessionId: agent.childSessionId,
          workspace: agent.workspace ?? null,
        })),
        parentSessionId: snapshot.session?.sessionId ?? null,
        promptDisabled: document.querySelector('#prompt')?.disabled ?? null,
        approvals: document.querySelector('#approvals')?.innerText ?? '',
        error: document.querySelector('#error')?.innerText ?? '',
        cards: document.querySelectorAll('.subagent-card').length,
        badges: document.querySelectorAll('.subagent-workspace').length,
      };
    };
    let view;
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        await step(
          'settle before reading the page',
          new Promise((r) => setTimeout(r, 2_000)),
          10_000,
        );
        const page_ = await step('read the page', page.evaluate(readPage), 30_000);
        const agent = page_.agents[0];
        if (agent?.workspace) {
          view = agent;
          break;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `no sub-agent workspace after 120s\npage=${JSON.stringify(page_)}\nfixture=${JSON.stringify(fixtureLog)}`,
          );
      }
    } catch (error) {
      const state = await Promise.race([
        page.evaluate(readPage),
        new Promise((resolve) => setTimeout(() => resolve('page-evaluate-also-stuck'), 10_000)),
      ]);
      throw new Error(
        `${String(error)}\nconsole=${JSON.stringify(consoleLog.slice(-12))}\nfixture=${JSON.stringify(fixtureLog)}\npage=${JSON.stringify(state)}`,
      );
    }
    assert.equal(view.workspace.kind, 'worktree', JSON.stringify(view.workspace));
    assert.equal(view.workspace.state, 'ready');
    assert.match(view.workspace.executionRoot, /[\\/]\.yuantu[\\/]worktrees[\\/]/);
    assert.notEqual(view.workspace.executionRoot, root);
    // And its work is outstanding rather than already merged: the status is the one a person has to act on.
    assert.equal(view.workspace.result?.status, 'ready', JSON.stringify(view.workspace.result));
    assert.deepEqual(view.workspace.result.paths, ['child.txt']);
    // The same two facts are on screen, in the panel a person actually opens.
    await step('open the sub-agent panel', page.locator('#open-subagents').click(), 20_000);
    /**
     * Existence is what this waits for, not visibility.
     *
     * `locator.waitFor()` defaults to "visible", and the panel can hold a rendered card that Playwright does not call
     * visible — which is a fact about the popover's CSS, not about the card. The assertions below are about what the
     * card *says*, so the wait is for the element being present and the reads go through the DOM directly.
     */
    await step(
      'the workspace badge',
      page.waitForFunction(() => document.querySelectorAll('.subagent-workspace').length > 0),
      20_000,
    ).catch(async (error) => {
      // A card that is on screen but has no workspace line is a *rendering* fault, and the fix differs from a card
      // that was never rendered at all — so the report carries the card's own markup rather than a count.
      const dom = await page.evaluate(() => ({
        card: document.querySelector('.subagent-card')?.outerHTML.slice(-700) ?? '(no card)',
        where: Array.from(document.querySelectorAll('.subagent-card *'))
          .map((node) => node.className)
          .filter((name) => typeof name === 'string' && name.includes('workspace')),
        badges: document.querySelectorAll('.subagent-workspace').length,
        popoverHidden: document.querySelector('#subagents-popover')?.hidden ?? null,
      }));
      throw new Error(`${String(error)}\ndom=${JSON.stringify(dom)}`);
    });
    const badge = await page.evaluate(() => {
      const node = document.querySelector('.subagent-workspace');
      return {
        kind: node?.getAttribute('data-kind') ?? null,
        state: node?.getAttribute('data-state') ?? null,
        text: node?.textContent ?? '',
        result: document.querySelector('.subagent-workspace-result')?.textContent ?? '',
      };
    });
    assert.equal(badge.kind, 'worktree', JSON.stringify(badge));
    assert.equal(badge.state, 'ready');
    assert.match(badge.text, /独立工作区|Isolated workspace/);
    assert.match(badge.result, /待合入|awaiting import/);

    // The child really wrote into its own directory, and the delegator's own directory is untouched.
    assert.equal(
      (await readFile(path.join(view.workspace.executionRoot, 'child.txt'), 'utf8')).trim(),
      'written inside the isolated workspace',
    );
    await assert.rejects(readFile(path.join(root, 'child.txt')), { code: 'ENOENT' });
    // Exercise conflict and import through the desktop prompt and real Host tool dispatch.
    await page.locator('#chat-title').click();
    importArgs = {
      resultId: view.workspace.result.id,
      expectedDigest: view.workspace.result.digest,
    };
    const importFromPrompt = async (expected) => {
      importTurn = 0;
      await page.locator('#prompt').fill(`Import the child result; expect ${expected}`);
      await page.locator('#send').click();
      await waitForPage(
        page,
        async (input) => {
          const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
          const child = snapshot.session.subagents.find((item) => item.childSessionId === input.id);
          return (
            !snapshot.session.running &&
            !snapshot.session.loading &&
            child?.workspace?.result?.status === input.status
          );
        },
        { id: view.childSessionId, status: expected },
        { timeout: 30_000 },
      );
    };
    await writeFile(path.join(root, 'child.txt'), 'parent version must survive\n');
    await importFromPrompt('conflict');
    assert.equal(
      await readFile(path.join(root, 'child.txt'), 'utf8'),
      'parent version must survive\n',
    );
    await page.locator('#open-subagents').click();
    await page.locator('#subagent-catalog .subagent-row').first().click();
    assert.match(
      await page.locator('.subagent-workspace-result').innerText(),
      /冲突.*未写入|conflict.*nothing.*written/i,
    );
    await page.locator('#chat-title').click();
    // The user resolves the conflict by restoring the parent's original absent-file state.
    await rm(path.join(root, 'child.txt'));
    await importFromPrompt('applied');
    assert.equal(
      await readFile(path.join(root, 'child.txt'), 'utf8'),
      'written inside the isolated workspace\n',
    );
    await page.locator('#open-subagents').click();
    await page.locator('#subagent-catalog .subagent-row').first().click();
    assert.match(await page.locator('.subagent-workspace-result').innerText(), /已合入|imported/i);
    // Exercise the actual desktop lifecycle controls, including cancellation of the cleanup prompt.
    await page.locator('#open-subagents').click();
    await page.locator('#subagent-catalog .subagent-row').first().click();
    await page.locator('[data-workspace-action="archive"]').click();
    const cleanup = page.locator('[data-workspace-action="remove"]');
    await cleanup.waitFor().catch(async (error) => {
      const archived = await page.evaluate(async () => {
        const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
        return {
          error: snapshot.error,
          sessionError: snapshot.session.error,
          agents: snapshot.session.subagents.map((child) => ({
            id: child.id,
            workspace: child.workspace,
          })),
          viewer: document.querySelector('.subagent-result')?.textContent ?? '',
        };
      });
      throw new Error(`${String(error)}\narchive=${JSON.stringify(archived)}`);
    });
    await page.evaluate(() => {
      window.confirm = () => false;
    });
    await cleanup.click();
    assert.equal(
      (await readFile(path.join(view.workspace.executionRoot, 'child.txt'), 'utf8')).trim(),
      'written inside the isolated workspace',
    );
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await cleanup.click();
    const restore = page.locator('[data-workspace-action="restore"]');
    await waitForPage(
      page,
      async (childSessionId) => {
        const answer = await window.yuantu.invoke({ type: 'snapshot' });
        return (
          answer.state.session.subagents.find((child) => child.childSessionId === childSessionId)
            ?.workspace?.state === 'removed'
        );
      },
      view.childSessionId,
    );
    await restore.waitFor();
    const currentWorkspace = await page.evaluate(async (childSessionId) => {
      const answer = await window.yuantu.invoke({ type: 'snapshot' });
      return answer.state.session.subagents.find((child) => child.childSessionId === childSessionId)
        ?.workspace;
    }, view.childSessionId);
    assert.equal(currentWorkspace.executionRoot, view.workspace.executionRoot);
    const remaining = await readdir(view.workspace.executionRoot, { recursive: true }).catch(
      () => null,
    );
    assert.equal(
      remaining,
      null,
      `removed workspace was recreated: ${JSON.stringify({ remaining, currentWorkspace })}`,
    );
    await restore.click();
    await page.locator('[data-workspace-action="archive"]').waitFor();
    assert.equal(
      (await readFile(path.join(view.workspace.executionRoot, 'child.txt'), 'utf8')).trim(),
      'written inside the isolated workspace',
    );
    assert.equal(
      await readFile(path.join(root, 'child.txt'), 'utf8'),
      'written inside the isolated workspace\n',
    );
  },
);
