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
      contents:
        "export * from './apps/desktop/i18n.ts';  export {setupSessionPanels} from './apps/desktop/renderer-session-panels.ts'; export {setupBackgroundView} from './apps/desktop/renderer-background.ts'; export {setupSubAgents} from './apps/desktop/renderer-subagents.ts'; export {setupQuestions} from './apps/desktop/renderer-questions.ts';",
      resolveDir: projectRoot,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'localeApi',
    platform: 'browser',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  return page;
}

async function planApprovalPage(t: test.TestContext) {
  const page = await desktopPage(t);
  if (!page) return null;
  await page.setViewportSize({ width: 1100, height: 700 });
  for (const file of ['styles.css', 'styles-panels.css', 'layout.css', 'layout-surfaces.css'])
    await page.addStyleTag({
      content: await readFile(path.join(projectRoot, 'apps/desktop', file), 'utf8'),
    });
  await page.evaluate(String.raw`
    localeApi.setLocale('zh-CN');
    document.documentElement.dataset.theme='dark';
    document.querySelector('#welcome').hidden=true;
    document.querySelector('#messages').style.height='1800px';
    window.planQuestions=[{id:'approval',request:{questions:[{
      id:'approve',header:'Plan approval',
      question:['Approve this plan and start carrying it out in this run?','','# 弹幕游戏','','使用 HTML + Canvas 2D 实现。','',
        ...Array.from({length:4},(_,i)=>(i+1)+'. '+['检查静态资源约定','创建游戏页面','实现核心循环','验证交付结果'][i]+'：'+('保留现有配置，完成本步骤后验证结果。'.repeat(12))),
        '','Plan digest: f04f4f93e4c9…'].join('\n'),
      options:[{label:'Approve and execute',description:'Lift read-only mode now and carry out the plan in this run.'},{label:'Keep planning'}]
    }]}}];
    window.questionView=localeApi.setupQuestions({
      markdownActions:{copy:async()=>{},open:async()=>{}},
      invoke:command=>{window.answerCommand=command;return new Promise(resolve=>window.finishAnswer=resolve)},
      setError:()=>{},requestRender:()=>questionView.render(planQuestions)
    });
    questionView.render(planQuestions);
    const conversation=document.querySelector('#conversation');
    conversation.scrollTop=conversation.scrollHeight;
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
      '批准这份计划，并在本轮开始执行吗？',
    );
    const steps = page.locator('#questions .question-plan ol > li');
    assert.equal(await steps.count(), 4);
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
  'selecting and submitting plan approval preserves the card and conversation scroll positions',
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
    assert.ok(before.card > 100, 'the plan must require scrolling to reach approval');
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
  'background entry follows current jobs even after a previous session had jobs',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await desktopPage(t);
    if (!page) return;
    const states = await page.evaluate<
      Record<
        'initial' | 'active' | 'switched' | 'completed' | 'cleared',
        { hidden: boolean; popoverHidden: boolean; expanded: string }
      >
    >(`(() => {
    Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:()=> '1',setItem(){}}});
    let state=null;
    const view=localeApi.setupBackgroundView({getState:()=>state,invoke:async()=>null});
    const read=()=>({hidden:document.querySelector('#open-background').hidden,popoverHidden:document.querySelector('#background-popover').hidden,expanded:document.querySelector('#open-background').getAttribute('aria-expanded')});
    view.render();const initial=read();
    state={session:{sessionId:'first'},background:[{id:'job',sessionId:'first',command:'node fixture',status:'running',exitCode:null,createdAt:new Date().toISOString()}]};
    view.render();document.querySelector('#open-background').click();const active=read();
    state={session:{sessionId:'second'},background:state.background};view.render();const switched=read();
    state.background=[{id:'done',sessionId:'second',command:'node quick',status:'completed',exitCode:0,createdAt:new Date().toISOString()}];view.render();const completed=read();
    state.background=[];view.render();const cleared=read();
    return {initial,active,switched,completed,cleared};
  })()`);
    assert.deepEqual(states.initial, { hidden: true, popoverHidden: true, expanded: 'false' });
    assert.equal(states.active.hidden, false);
    assert.equal(states.active.popoverHidden, false);
    assert.deepEqual(states.switched, states.initial);
    assert.equal(states.completed.hidden, false);
    assert.deepEqual(states.cleared, states.initial);
  },
);

test(
  'background rows share subagent status markers and the entry has no icon',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await desktopPage(t);
    if (!page) return;
    await page.setViewportSize({ width: 1100, height: 550 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const file of [
      'styles.css',
      'styles-subagents.css',
      'styles-panels.css',
      'layout.css',
      'layout-surfaces.css',
      'layout-workspace.css',
    ])
      await page.addStyleTag({
        content: await readFile(path.join(projectRoot, 'apps/desktop', file), 'utf8'),
      });
    await page.evaluate(`
    localeApi.setLocale('zh-CN');
    document.documentElement.dataset.theme='dark';
    window.backgroundState={session:{sessionId:'s',running:false,loading:false},background:[
      {id:'active',sessionId:'s',command:'node scripts/run-tests.mjs',status:'running',exitCode:null,createdAt:new Date().toISOString()},
      {id:'done',sessionId:'s',command:'powershell.exe -NoProfile -Command fixture',status:'completed',exitCode:0,createdAt:new Date(Date.now()-3000).toISOString(),finishedAt:new Date().toISOString()}
    ]};
    window.backgroundTestView=localeApi.setupBackgroundView({getState:()=>backgroundState,invoke:async()=>null});
    window.subagentTestView=localeApi.setupSubAgents(()=>backgroundState,()=>{},()=>document.createElement('div'));
    subagentTestView.update(['running','completed'].map((status,index)=>({id:'child-'+index,childSessionId:'child-session-'+index,index,total:2,role:'general',objective:'fixture',status,rounds:1,toolCalls:0,text:''})));
    backgroundTestView.render();
    document.querySelector('#open-background').click();
  `);
    const read = () =>
      page.evaluate(`(() => {
    const top=document.querySelector('#open-background');
    const icons=[...document.querySelectorAll('.background-dot')];
    const reference=[...document.querySelectorAll('#subagent-catalog .subagent-row-dot')];
    const appearance=icon=>{const style=getComputedStyle(icon);return [style.width,style.height,style.backgroundColor,style.animationName]};
    return {top:top.dataset.status,entryIcons:top.querySelectorAll('.background-icon,.background-chevron').length,
      labels:icons.map(icon=>icon.getAttribute('aria-label')),
      animations:icons.map(icon=>getComputedStyle(icon).animationName),
      shared:icons.every(icon=>icon.classList.contains('subagent-row-dot')),
      appearance:icons.map(appearance),reference:reference.map(appearance)};
  })()`) as Promise<{
        top: string;
        entryIcons: number;
        labels: string[];
        animations: string[];
        shared: boolean;
        appearance: string[][];
        reference: string[][];
      }>;
    const active = await read();
    assert.equal(active.top, 'running');
    assert.equal(active.entryIcons, 0);
    assert.equal(active.shared, true);
    assert.deepEqual(active.appearance, active.reference);
    assert.deepEqual(active.labels, ['运行中', '已完成']);
    assert.notEqual(active.animations[0], 'none');
    assert.equal(active.animations[1], 'none');
    await page.evaluate(
      `backgroundState.background[0].status='completed';backgroundState.background[0].exitCode=0;backgroundTestView.render();`,
    );
    const finished = await read();
    assert.equal(finished.top, 'completed');
    assert.equal(finished.entryIcons, 0);
    assert.deepEqual(finished.labels, ['已完成', '已完成']);
    assert.deepEqual(finished.animations, ['none', 'none']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      `backgroundState.background[0].status='running';backgroundTestView.render();`,
    );
    assert.equal((await read()).animations[0], 'none');
  },
);

for (const surface of ['background', 'workspace']) {
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
        const view = localeApi.setupSubAgents(()=>state, command => command.type==='subagentWorkspace' ? invoke() : undefined, () => document.createElement('div'));
        update = () => view.update([child]); update();
        document.querySelector('.subagent-view').click(); update();
        button = () => document.querySelector('[data-workspace-action="archive"]');
      }
      button().click();
      const pendingDisabled = button().disabled;
      rejectAction(new Error('fixture IPC rejected'));
      await new Promise(resolve => setTimeout(resolve,20));
      const recovered = !button().disabled;
      button().click();
      const retried = calls === 2;
      state.session.running = true;
      update();
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
  'locale round trips restore static attributes and preserve real session names and file paths',
  { timeout: 30000, skip: electronSkip },
  async (t) => {
    const page = await desktopPage(t);
    if (!page) return;
    await page.evaluate(`
    window.yuantu = { files: async (command) => command.type === 'read' ? ({ok:true,preview:{kind:'text',text:'file bytes',path:command.path}}) : ({ok:true, listing:{path:'', entries:[{name:'工具',path:'工具',kind:'file'},{name:'保存',path:'保存',kind:'file'}]}}) };
    const fixture = document.createElement('input'); fixture.id='locale-attribute';
    for (const name of ['title','aria-label','placeholder']) fixture.setAttribute(name,'设置');
    document.body.append(fixture);
    const panels = localeApi.setupSessionPanels(() => ({session:{sessionId:'abc123',messages:[{role:'user',content:'ask'},{role:'assistant',content:'',toolCalls:[{name:'todo_write'}]}]}}));
    panels.todos([{content:'保存',status:'pending'}]);
    panels.goal({objective:'工具',status:'active',roundsStarted:0,maxGoalRounds:3});
    panels.deliverables([{path:'设置',description:'保存',bytes:2,sha256:'a'.repeat(64),at:new Date().toISOString()}]);
    localeApi.setLocale('en-US');
  `);
    assert.equal(await page.locator('#locale-attribute').getAttribute('title'), 'Settings');
    assert.equal(await page.locator('.todo-content').textContent(), '保存');
    assert.equal(await page.locator('#goal-objective').textContent(), '工具');
    assert.equal(await page.locator('.deliverable-path').textContent(), '设置');
    assert.equal(await page.locator('.deliverable-description').textContent(), '保存');
    await page.evaluate(`localeApi.setLocale('zh-CN');`);
    for (const attribute of ['title', 'aria-label', 'placeholder'])
      assert.equal(await page.locator('#locale-attribute').getAttribute(attribute), '设置');
    // A freshly assigned attribute must become the new source, even while English is selected.
    await page.evaluate(
      `localeApi.setLocale('en-US'); document.querySelector('#locale-attribute').setAttribute('title','新建会话');`,
    );
    await page.waitForFunction(
      `document.querySelector('#locale-attribute').title === 'New session'`,
    );
    await page.evaluate(`localeApi.setLocale('zh-CN')`);
    assert.equal(await page.locator('#locale-attribute').getAttribute('title'), '新建会话');
  },
);

// The command vocabulary's language/alias/refusal rules are covered by tests/desktop-react-composer.test.ts.
