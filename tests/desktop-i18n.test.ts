// @test-serial desktop-ui: Launches a real Electron window for renderer i18n tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { projectRoot } from './process-fixture.ts';
import { translate } from '../apps/desktop/i18n.ts';

/**
 * The installed Electron executable, found the way the `electron` package finds it but without its fallback.
 *
 * Importing `electron` downloads the binary when it is missing, writing into node_modules — which the isolation
 * harness refuses, and which a machine without the binary (the Linux check job) should not do inside a test.
 */
function installedElectron(): string | undefined {
  const root = path.join(projectRoot, 'node_modules', 'electron');
  try {
    const executable = path.join(root, 'dist', readFileSync(path.join(root, 'path.txt'), 'utf8'));
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}
const electronPath = installedElectron();
/**
 * Whether Electron can start here at all.
 *
 * A present binary is not enough: a sandbox policy, a session without a desktop, or a broken install can make
 * every launch fail. Probe with the same default launch path Playwright uses before any test starts, so the
 * whole file skips with one reason instead of reporting one test failure per launch attempt.
 */
function electronLaunchProblem(executable: string): string | undefined {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env,
  });
  if (result.error) return `Electron could not start: ${result.error.message}`;
  if (result.status !== 0)
    return `Electron could not start (exit ${String(result.status ?? result.signal)})`;
  return undefined;
}
const electronSkip = electronPath
  ? electronLaunchProblem(electronPath)
  : 'the Electron binary is not installed (npx install-electron)';

async function desktopPage(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-dom-locale-'));
  const main = path.join(root, 'main.cjs');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  // Electron's own module is provided by its runtime, not by Node resolution from this temporary directory.
  await writeFile(
    main,
    "const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{ new BrowserWindow({show:false}).loadURL('about:blank'); }); app.on('window-all-closed',()=>app.quit());",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await electron.launch({
      executablePath: String(electronPath),
      args: [main, `--user-data-dir=${path.join(root, 'profile')}`],
      env,
    });
  } catch (error) {
    // The binary can exist and still be unable to start here (no desktop session, a sandbox policy, a broken
    // install). That is a property of the host, not of the renderer under test; skip with the launch error
    // instead of turning it into seven assertion failures.
    t.skip(
      `Electron could not launch on this host: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const page = await app.firstWindow();
  const html = await readFile(path.join(projectRoot, 'apps/desktop/index.html'), 'utf8');
  // This isolated harness injects a test bundle; the product CSP stays unchanged.
  await page.setContent(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, ''),
  );
  const bundle = await build({
    stdin: {
      contents: [
        "export * from './apps/desktop/i18n.ts';",
        "export {mountSubagents} from './apps/desktop/ui/conversation/subagents-mount.tsx';",
        "export {mountQuestions} from './apps/desktop/ui/conversation/questions-mount.tsx';",
        "export {mountSummary} from './apps/desktop/ui/panels/summary-mount.tsx';",
        "export {ProductShell} from './apps/desktop/ui/layout/ProductShell.tsx';",
        "export {updateChrome} from './apps/desktop/ui/chrome.ts';",
        "export {useLocale} from './apps/desktop/ui/i18n.ts';",
        "export {MantineProvider} from '@mantine/core';",
        "export {flushSync} from 'react-dom';",
        "export {createElement, useState, Fragment} from 'react';",
        "export {createRoot} from 'react-dom/client';",
      ].join('\n'),
      resolveDir: projectRoot,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'localeApi',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.evaluate(`(() => {
    window.localeRoot = localeApi.createRoot(document.getElementById('desktop-root'));
    localeApi.flushSync(() => localeRoot.render(localeApi.createElement(localeApi.MantineProvider, null, localeApi.createElement(localeApi.ProductShell))));
  })()`);
  return page;
}

async function planApprovalPage(t: test.TestContext) {
  const page = await desktopPage(t);
  if (!page) return null;
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addStyleTag({
    content: await readFile(
      path.join(projectRoot, 'node_modules/@mantine/core/styles.css'),
      'utf8',
    ),
  });
  for (const file of ['styles.css', 'styles-panels.css', 'layout.css', 'layout-surfaces.css'])
    await page.addStyleTag({
      content: await readFile(path.join(projectRoot, 'apps/desktop', file), 'utf8'),
    });
  await page.addStyleTag({
    content: await readFile(path.join(projectRoot, 'apps/desktop/ui/styles.css'), 'utf8'),
  });
  await page.evaluate(String.raw`
    (async () => {
    localeApi.setLocale('zh-CN');
    document.documentElement.dataset.theme='dark';
    localeApi.flushSync(() => localeApi.updateChrome({welcomeVisible:false}));
    document.querySelector('#messages').style.height='1800px';
    window.planQuestions=[{id:'approval',request:{questions:[{
      id:'approve',header:'Plan approval',
      question:['Approve this plan and start carrying it out in this run?','','# 弹幕游戏','','使用 HTML + Canvas 2D 实现。','',
        ...Array.from({length:4},(_,i)=>(i+1)+'. '+['检查静态资源约定','创建游戏页面','实现核心循环','验证交付结果'][i]+'：'+('保留现有配置，完成本步骤后验证结果。'.repeat(12))).flatMap((line,index)=>index?['',line]:[line]),
        '','Plan digest: f04f4f93e4c9…'].join('\n'),
      options:[{label:'Approve and execute',description:'Lift read-only mode now and carry out the plan in this run.'},{label:'Keep planning'}]
    }]}}];
    window.questionView=localeApi.mountQuestions({
      markdownActions:{copy:async()=>{},open:async()=>{}},
      invoke:command=>{window.answerCommand=command;return new Promise(resolve=>window.finishAnswer=resolve)},
      setError:()=>{},requestRender:()=>questionView.render(planQuestions)
    });
    questionView.render(planQuestions);
    // The panel now draws through the one React root, like every migrated region: mount the region host into the
    // product's #desktop-root and wait for the portal to commit before measuring scroll positions.
    window.questionRoot=localeRoot;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const conversation=document.querySelector('#conversation');
    conversation.scrollTop=conversation.scrollHeight;
    })()
  `);
  return page;
}

test(
  'plan approval separates the prompt from the plan and displays each numbered step on its own line',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await planApprovalPage(t);
    if (!page) return;
    assert.equal(
      await page.locator('#questions .question-title').innerText(),
      translate('question.plan.intro', 'zh-CN'),
    );
    const steps = page.locator('#questions .question-plan ol > li');
    assert.equal(await steps.count(), 4);
    // Blank lines between numbered items must not split the plan into one list per item: the numbers would restart.
    assert.equal(await page.locator('#questions .question-plan ol').count(), 1);
    const appearance = await steps.evaluateAll((nodes) =>
      nodes.map((node) => ({
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
        size: parseFloat(getComputedStyle(node).fontSize),
        weight: Number(getComputedStyle(node).fontWeight),
      })),
    );
    assert.ok(appearance.every((step) => step.size <= 14 && step.weight <= 400));
    assert.ok(appearance.slice(1).every((step, index) => step.top >= appearance[index]!.bottom));
    assert.equal(await page.locator('#questions .question-plan h1').innerText(), '弹幕游戏');
    assert.doesNotMatch(await page.locator('#questions').innerText(), /Plan digest/);
  },
);

test(
  'long plan questions use conversation scrolling and preserve it when selected or submitted',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await planApprovalPage(t);
    if (!page) return;
    const option = page.locator('.question-option').first();
    await option.scrollIntoViewIfNeeded();
    const scroll = () =>
      page.evaluate(() => ({
        card: document.querySelector('.question-card')!.scrollTop,
        conversation: document.querySelector('#conversation')!.scrollTop,
      }));
    const before = await scroll();
    assert.equal(before.card, 0, 'the question card must not scroll internally');
    assert.equal(
      await page
        .locator('.question-card')
        .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
      true,
      'the card grows to fit its content',
    );
    assert.ok(before.conversation > 100, 'the conversation must already be scrolled');
    await option.click();
    const selected = await scroll();
    assert.ok(Math.abs(selected.card - before.card) < 4, JSON.stringify({ before, selected }));
    assert.ok(Math.abs(selected.conversation - before.conversation) < 4);
    assert.equal(
      await page.locator('.question-option.selected').innerText(),
      await option.innerText(),
    );
    await page.locator('.question-submit').scrollIntoViewIfNeeded();
    const submitting = await scroll();
    await page.locator('.question-submit').click();
    const submitted = await scroll();
    assert.ok(
      Math.abs(submitted.card - submitting.card) < 4,
      JSON.stringify({ submitting, submitted }),
    );
    assert.ok(Math.abs(submitted.conversation - submitting.conversation) < 4);
    assert.equal(await page.locator('.question-submit').isDisabled(), true);
    assert.deepEqual(await page.evaluate('answerCommand.answers'), [
      { id: 'approve', selected: ['Approve and execute'] },
    ]);
    await page.evaluate('finishAnswer(null)');
  },
);

test(
  'question paging preserves drafts, uses a single-row fixed input and keeps collapse controls usable',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await planApprovalPage(t);
    if (!page) return;
    await page.evaluate(String.raw`
      (() => {
        const long = '长问题随对话区域滚动，选项和提交按钮仍需可达。'.repeat(60);
        window.pagedQuestions=[{id:'paged',request:{questions:[
          {id:'one',header:'第一题',question:long,options:[{label:'继续'}]},
          {id:'two',header:'第二题',question:long,options:[{label:'返回'}]}
        ]}}];
        questionView.render(pagedQuestions);
      })()
    `);
    const card = page.locator('.question-card');
    const count = card.locator('.question-count');
    await count.filter({ hasText: '1/2' }).waitFor();
    const input = card.locator('.question-input');
    const inputLayout = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      resize: getComputedStyle(element).resize,
    }));
    assert.ok(inputLayout.height <= 44, `answer input should be one row: ${inputLayout.height}`);
    assert.equal(inputLayout.resize, 'none');
    await input.fill('保留这一题的答案');
    await card.locator('.question-next').click();
    await count.filter({ hasText: '2/2' }).waitFor();
    assert.equal(await input.inputValue(), '');
    await card.locator('.question-prev').click();
    await count.filter({ hasText: '1/2' }).waitFor();
    assert.equal(await input.inputValue(), '保留这一题的答案');
    const collapse = card.getByRole('button', {
      name: translate('ui.questionCollapse', 'zh-CN'),
      exact: true,
    });
    assert.equal(await collapse.locator('svg').isVisible(), true);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    await collapse.click();
    assert.equal(await card.locator('.question-body').isVisible(), false);
    const expand = card.getByRole('button', {
      name: translate('ui.questionExpand', 'zh-CN'),
      exact: true,
    });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await expand.click();
    assert.equal(await input.isVisible(), true);
    assert.equal(await input.inputValue(), '保留这一题的答案');
    assert.equal(
      await card.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
      true,
    );
  },
);

for (const surface of ['workspace']) {
  test(
    `failed IPC restores ${surface} actions for retry`,
    { timeout: 30000, skip: electronSkip },
    async (t) => {
      const page = await desktopPage(t);
      if (!page) return;
      const result = (await page.evaluate(`(async () => {
      window.addEventListener('unhandledrejection', event => event.preventDefault());
      let calls = 0, rejectAction;
      const state = {session:{sessionId:'parent',running:false,loading:false},background:[{id:'job',sessionId:'parent',command:'fixture',status:'running',exitCode:null,createdAt:new Date().toISOString()}]};
      const invoke = () => { calls++; return new Promise((_, reject) => { rejectAction = reject; }); };
      let button, update;
      if ('${surface}' === 'background') {
        const view = localeApi.setupBackgroundView({getState:()=>state,invoke});
        update = () => view.render(); update();
        button = () => document.querySelector('.background-stop');
      } else {
        const child = {id:'child',childSessionId:'child-session',index:0,total:1,role:'general',objective:'fixture',status:'completed',rounds:1,toolCalls:0,text:'done',workspace:{kind:'worktree',executionRoot:'/fixture',state:'ready'}};
        state.subagentTranscript={subagentId:child.id,childSessionId:child.childSessionId,objective:child.objective,status:'completed',messages:[],truncated:false};
        const root = localeRoot;
        const view = localeApi.mountSubagents({
          getState:()=>state,
          send: command => command.type==='subagentWorkspace' ? invoke() : undefined,
          renderMessage: () => document.createElement('div')
        });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        update = () => view.update([child]); update();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.querySelector('.subagent-view').click(); update();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        button = () => document.querySelector('[data-workspace-action="archive"]');
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      button().click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const pendingDisabled = button().disabled;
      rejectAction(new Error('fixture IPC rejected'));
      await new Promise(resolve => setTimeout(resolve,20));
      const recovered = !button().disabled;
      button().click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const retried = calls === 2;
      state.session.running = true;
      update();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rejectAction(new Error('fixture IPC rejected again'));
      await new Promise(resolve => setTimeout(resolve,20));
      return {pendingDisabled,recovered,retried,busyDisabled:button()?.disabled};
    })()`)) as {
        pendingDisabled: boolean;
        recovered: boolean;
        retried: boolean;
        busyDisabled: boolean;
      };
      assert.equal(result.pendingDisabled, true);
      assert.equal(result.recovered, true);
      assert.equal(result.retried, true);
      if (surface === 'workspace') assert.equal(result.busyDisabled, true);
    },
  );
}

test(
  'locale round trips update React attributes and preserve unrelated user content',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await desktopPage(t);
    if (!page) return;
    await page.evaluate(`
    (() => { function AttributeFixture() {
      localeApi.useLocale();
      const [key, changeKey] = localeApi.useState('ui.settings');
      window.changeAttributeKey = changeKey;
      return localeApi.createElement('input', { id: 'locale-attribute', title: localeApi.t(key), 'aria-label': localeApi.t(key), placeholder: localeApi.t(key) });
    }
    localeApi.flushSync(() => localeRoot.render(localeApi.createElement(localeApi.MantineProvider, null,
      localeApi.createElement(localeApi.Fragment, null, localeApi.createElement(localeApi.ProductShell), localeApi.createElement(AttributeFixture)))));
    const userContent = document.createElement('p'); userContent.id='locale-user-content';
    userContent.textContent='设置/新建会话.txt'; document.body.append(userContent);
    localeApi.flushSync(() => localeApi.setLocale('en-US'));
    })();
  `);
    assert.equal(await page.locator('#locale-attribute').getAttribute('title'), 'Settings');
    await page.evaluate(`localeApi.flushSync(() => localeApi.setLocale('zh-CN'));`);
    for (const attribute of ['title', 'aria-label', 'placeholder'])
      assert.equal(
        await page.locator('#locale-attribute').getAttribute(attribute),
        translate('ui.settings', 'zh-CN'),
      );
    // A React label can change while English is selected; its new key survives the locale round trip.
    await page.evaluate(
      `localeApi.flushSync(() => { localeApi.setLocale('en-US'); changeAttributeKey('ui.newSession'); });`,
    );
    await page.waitForFunction(
      `document.querySelector('#locale-attribute').title === 'New session'`,
    );
    await page.evaluate(`localeApi.flushSync(() => localeApi.setLocale('zh-CN'))`);
    assert.equal(
      await page.locator('#locale-attribute').getAttribute('title'),
      translate('ui.newSession', 'zh-CN'),
    );
    assert.equal(await page.locator('#locale-user-content').innerText(), '设置/新建会话.txt');
  },
);

test(
  'summary stays compact and refreshes an open popover for each turn and live result',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await desktopPage(t);
    if (!page) return;
    await page.setViewportSize({ width: 1100, height: 700 });
    for (const file of [
      'styles.css',
      'styles-panels.css',
      'layout.css',
      'layout-surfaces.css',
      'ui/styles.css',
    ])
      await page.addStyleTag({
        content: await readFile(path.join(projectRoot, 'apps/desktop', file), 'utf8'),
      });
    await page.evaluate(`(() => {
      localeApi.setLocale('zh-CN');
      localeApi.flushSync(() => localeApi.updateChrome({welcomeVisible:false}));
      const calls = Array.from({length:18}, (_,i) => ({id:'old-'+i,name:'scan_target_resolve',arguments:{purl:'pkg:github/torvalds/linux',limit:5}}));
      window.summarySnapshot = {session:{sessionId:'summary-session',running:false,tools:[],messages:[
        {role:'user',content:'first'},
        {role:'assistant',content:'',toolCalls:calls},
        ...calls.map(call=>({role:'tool',toolCallId:call.id,content:'ok',isError:false}))
      ]}};
      window.summaryHandle = localeApi.mountSummary({getState:()=>summarySnapshot});
      summaryHandle.render();
    })()`);
    await page.locator('#open-summary').click();
    const popover = page.locator('#summary-popover');
    const rows = popover.locator('.summary-call');
    await page.waitForFunction(`document.querySelectorAll('.summary-call').length === 18`);
    const layout = await popover.evaluate((element) => {
      const list = element.querySelector('.summary-calls')!;
      return {
        height: element.getBoundingClientRect().height,
        scrollable: list.scrollHeight > list.clientHeight,
      };
    });
    assert.ok(layout.height <= 330, `summary should stay compact: ${layout.height}`);
    assert.equal(layout.scrollable, true, 'only the call list should scroll');
    await page.evaluate(`(() => {
      // The bridge's mirror retains the outer object and replaces the session section.
      summarySnapshot.session = {...summarySnapshot.session,running:true,messages:[...summarySnapshot.session.messages,{role:'user',content:'second'}]};
      summaryHandle.render();
    })()`);
    await popover.locator('.summary-empty').waitFor();
    assert.equal(await rows.count(), 0);
    assert.equal(await popover.isVisible(), true);
    await page.evaluate(`(() => {
      summarySnapshot.session = {...summarySnapshot.session,tools:[{id:'new',name:'scan_vuln_query',arguments:{limit:10}}]};
      summaryHandle.render();
    })()`);
    await rows.filter({ hasText: 'vuln_query' }).waitFor();
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().getAttribute('data-status'), 'running');
    await page.evaluate(`(() => {
      const call = summarySnapshot.session.tools[0];
      summarySnapshot.session = {...summarySnapshot.session,running:false,tools:[],messages:[...summarySnapshot.session.messages,
        {role:'assistant',content:'',toolCalls:[call]},
        {role:'tool',toolCallId:'new',content:'ok',isError:false}
      ]};
      summaryHandle.render();
    })()`);
    await page.waitForFunction(
      `document.querySelector('.summary-call')?.dataset.status === 'succeeded'`,
    );
    assert.equal(await rows.count(), 1);
    assert.doesNotMatch(await popover.innerText(), /target_resolve/);
  },
);
