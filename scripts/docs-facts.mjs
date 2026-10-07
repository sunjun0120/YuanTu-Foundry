/**
 * The numbers the documentation quotes, computed from the code.
 *
 * Documentation drifts because the numbers in it are typed by hand and verified by nobody: this repository's
 * own audit found the tool count, the schema size, the explore allowlist arithmetic, an agent-facing tool
 * description and an audit conclusion that had all stopped being true while still reading as facts. Reading a
 * number is not the same as *checking* one, so this script computes the facts from the modules that own them
 * and either writes them into the documents (`--write`) or fails when the documents disagree (`--check`,
 * which is what `npm run check` runs).
 *
 * Two kinds of claim are covered, because they need different treatment:
 *
 * 1. **Generated facts** — counts and sizes that only code can answer. They live in a marked block; the script
 *    rewrites the block, so the only way to make them stale is to stop running the check.
 * 2. **Prose claims** — sentences that assert something the block cannot express ("no branch or worktree
 *    support", "the compaction's tokens are not counted"). These are listed below as forbidden strings: the
 *    string is banned because it *was* true and stopped being true, and a check that only looks at numbers
 *    would not notice it coming back.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTools } from '../packages/tools/index.ts';
import { TerminalSessions } from '../packages/tools/terminal.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { SESSION_EVENT_TYPES } from '../packages/storage/events.ts';
import { AGENT_EVENT_TYPES } from '../packages/protocol/index.ts';
import { ENVIRONMENT, settingShape } from '../packages/protocol/settings.ts';
import {
  EXPLORE_TOOLS,
  SUBAGENT_CEILINGS,
  SUBAGENT_DEFAULTS,
  SubAgentCoordinator,
} from '../packages/core/subagents.ts';
import { SubAgentProviderRegistry } from '../packages/core/subagent-providers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

/** The schema version the store stamps, read from a fresh database rather than from a constant. */
async function schemaVersion() {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-docs-'));
  const store = new SessionStore(path.join(directory, 'sessions.sqlite'));
  const db = new DatabaseSync(path.join(directory, 'sessions.sqlite'));
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
/**
 * The `collect_subagents` description, read from the tool the model actually receives: a description that
 * disagrees with the schema beside it is a behaviour-level inconsistency, not a documentation one.
 */
function collectTool() {
  return new SubAgentCoordinator({
    options: { ...SUBAGENT_DEFAULTS, enabled: true, collectWaitMs: 5_000 },
    emit: () => {},
    signal: new AbortController().signal,
    onUsage: () => {},
    readOnly: false,
    providers: new SubAgentProviderRegistry(),
    provider: 'in-process',
    depth: 0,
  }).collectTool();
}

async function facts() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-facts-workspace-'));
  /**
   * A terminal manager, because every host that ships passes one.
   *
   * The six `terminal_*` tools appear in a registry only when its host supplied a manager (see `createTools`),
   * and `apps/cli` and `apps/agent-host` both do — so leaving it out here would measure a catalogue with one
   * family missing and call the result "tools (all)". Creating the manager imports no native module: the optional
   * pty dependency is loaded when a terminal is opened, never before. Declared outside the `try` so the `finally`
   * that closes it can see it.
   */
  const terminals = new TerminalSessions(workspace);
  try {
    const tools = createTools(workspace, undefined, 'standalone', undefined, undefined, terminals);
    const all = tools.specs();
    const readOnly = tools.specs({ readOnly: true });
    /**
     * The folded catalog, measured rather than described.
     *
     * `YUANTU_TOOL_MODE=ptc` replaces every schema with one `run_code` carrying a generated declaration list, and
     * the whole point of the mode is that the number goes down — so the number belongs in the table the docs gate
     * keeps honest, next to the unfolded one it is meant to be compared with.
     */
    tools.toolMode = 'ptc';
    const folded = tools.specs();
    tools.toolMode = 'native';
    const packageJson = JSON.parse(await read(path.join('package.json')));
    const smokeSuites = String(packageJson.scripts['smoke:desktop'])
      .split(/\s+/)
      .filter((part) => part.endsWith('.smoke.mjs')).length;
    /**
     * Test files and snapshot scenarios are counted rather than written down: both grow with every change, and a
     * hand-written number is how the README ended up claiming 36 test files while the directory held far more.
     */
    const tests = await readdir(path.join(root, 'tests'));
    const snapshots = await readdir(path.join(root, 'tests', 'snapshots'));
    return {
      toolsAll: all.length,
      toolsBytes: JSON.stringify(all).length,
      toolsReadOnly: readOnly.length,
      toolsReadOnlyBytes: JSON.stringify(readOnly).length,
      toolsFolded: folded.length,
      toolsFoldedBytes: JSON.stringify(folded).length,
      exploreTools: EXPLORE_TOOLS.length,
      sessionSchema: await schemaVersion(),
      sessionEventTypes: SESSION_EVENT_TYPES.length,
      agentEventTypes: AGENT_EVENT_TYPES.length,
      desktopSmokeSuites: smokeSuites,
      testFiles: tests.filter((name) => name.endsWith('.test.ts')).length,
      snapshotScenarios: snapshots.filter((name) => name.endsWith('.json')).length,
      collectWaitMax: SUBAGENT_CEILINGS.collectWaitMs,
    };
  } finally {
    terminals.closeAll();
    await rm(workspace, { recursive: true, force: true });
  }
}
const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KB';

function table(value) {
  return [
    '| 指标 | 值 | 来源 |',
    '| --- | --- | --- |',
    `| 工具（空工作区，全部） | ${value.toolsAll} 个 / ${kb(value.toolsBytes)} | \`createTools().specs()\` |`,
    `| 工具（只读运行） | ${value.toolsReadOnly} 个 / ${kb(value.toolsReadOnlyBytes)} | \`specs({ readOnly: true })\` |`,
    `| 工具（折叠为 \`run_code\`） | ${value.toolsFolded} 个 / ${kb(value.toolsFoldedBytes)} | \`specs()\`（\`YUANTU_TOOL_MODE=ptc\`） |`,
    `| \`explore\` 白名单条目 | ${value.exploreTools} 条 | \`EXPLORE_TOOLS\` |`,
    `| 会话 schema 版本 | v${value.sessionSchema} | 新建库上的 \`PRAGMA user_version\` |`,
    `| 持久事件类型 / 实时事件类型 | ${value.sessionEventTypes} / ${value.agentEventTypes} | \`SESSION_EVENT_TYPES\`、\`AGENT_EVENT_TYPES\` |`,
    `| 桌面冒烟套件 | ${value.desktopSmokeSuites} | \`smoke:desktop\` 的清单 |`,
    `| 行为测试文件 | ${value.testFiles} 个 | \`tests/*.test.ts\` |`,
    `| 整轮快照场景 | ${value.snapshotScenarios} 个 | \`tests/snapshots/*.json\`（\`npm run snapshot:update\` 重写） |`,
    `| \`collect_subagents\` 的等待上限 | ${value.collectWaitMax} ms | \`SUBAGENT_CEILINGS.collectWaitMs\`（描述文本与 schema 必须一致） |`,
  ].join('\n');
}
const START = '<!-- facts:start -->';
const END = '<!-- facts:end -->';
/**
 * The settings catalogue: the second generated block, and the only reader the table's own descriptions have.
 *
 * Every `YUANTU_*` name is registered in `ENVIRONMENT` with a kind, its bounds and a sentence saying what it does.
 * The desktop draws its own bilingual labels and the CLI help lists a curated subset, so that sentence had no
 * reader at all — a field that could drift from the code without anybody noticing, which is the same defect the
 * facts block exists for. Rendering it here means registering a variable documents it, and changing its meaning
 * changes the document on the next `docs:generate`.
 */
const SETTINGS_START = '<!-- settings:start -->';
const SETTINGS_END = '<!-- settings:end -->';
/** A `|` inside a description would end the cell it is in; escaped rather than dropped. */
const cell = (text) => String(text).replace(/\|/g, '\\|');
function settingsTable() {
  const rows = Object.entries(ENVIRONMENT).map(([name, spec]) => {
    // The shape as the one owner of that question describes it, in code spans: the table used to re-derive it per
    // kind, which was a second copy of `settingShape` and printed `字符串` for a setting whose own rule accepts
    // exactly four words.
    const shape = settingShape(spec)
      .split(' / ')
      .map((value) => `\`${value}\``)
      .join(' / ');
    return `| \`${name}\` | ${shape} | ${cell(spec.description)} |`;
  });
  return ['| 变量 | 取值 | 说明 |', '| --- | --- | --- |', ...rows].join('\n');
}
function settingsBlock() {
  return [
    SETTINGS_START,
    '',
    `**由代码算出**：共 ${Object.keys(ENVIRONMENT).length} 个名字，取自 \`packages/protocol/settings.ts\` 的 \`ENVIRONMENT\`；\`npm run docs:generate\` 重写，\`docs:check\` 在不一致时失败。`,
    '',
    // Generated, so Prettier must leave the table exactly as written.
    '<!-- prettier-ignore -->',
    settingsTable(),
    '',
    SETTINGS_END,
  ].join('\n');
}
function block(value) {
  /**
   * The three blank lines are part of the emitted block rather than decoration: Prettier wants one after the
   * start marker, one before the ignore comment and one before the end marker, and `format:check` runs before
   * `docs:check`. Emitting the block Prettier would have written is what keeps `docs:generate` from leaving
   * behind a tree that fails the check that runs first — which is what happened while they were missing.
   */
  return [
    START,
    '',
    '本节数字**由代码算出**：`npm.cmd run docs:generate` 重写，`npm.cmd run docs:check` 会在文档与代码不一致时失败（`scripts/docs-facts.mjs`）。',
    '',
    // Generated, so Prettier must leave the table exactly as written. The comparison normalises whitespace
    // as well, which keeps the check working if that ever changes.
    '<!-- prettier-ignore -->',
    table(value),
    '',
    END,
  ].join('\n');
}
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
/**
 * Claims that were true once and are not any more. Each needs a reason, because a forbidden string with no
 * reason is indistinguishable from a typo someone will "fix" by deleting the check.
 */
const FORBIDDEN = [
  ['52 个工具', 'README 的工具总数已过时（见生成事实表）'],
  ['22.3 KB', 'README 的 schema 体积已过时（见生成事实表）'],
  ['再削掉 6 个', 'explore 白名单的算术与 EXPLORE_TOOLS 条目数不符'],
  ['21 个冒烟文件', 'smoke:desktop 的套件数由 package.json 决定，见生成事实表'],
  ['26 个用例、26 通过', '桌面冒烟的用例数不再固定，写死会过期'],
  // The file count itself is used by a dated record ("合并为 36 个 .test.ts"), so only the *undated* claim shape
  // — a number written into the project-structure listing — is forbidden here; the live number is in the table.
  ['36 个 *.test.ts', '行为测试文件数写在结构清单里会过期，见生成事实表'],
  ['桌面冒烟（4 个套件）', '冒烟套件数由 package.json 决定，见生成事实表'],
  [
    'up to 30000',
    'collect_subagents 的等待上限由 SUBAGENT_CEILINGS 决定，描述文本必须与 schema 一致',
  ],
  ['无 branch、worktree', 'git_branches / git_worktrees / git_worktree_create 已经发布'],
  ['消耗的 Token 不计入运行统计', '压缩的用量已随检查点记录并折进会话统计'],
  ['scripts/live-workflow-probe.mjs 不符合 Prettier 格式', '该脚本已不再破坏格式检查'],
];

/**
 * The documents whose claims are supposed to be true *now*.
 *
 * Dated records are excluded on purpose: a `docs/validation-*.md` record reports what was measured on the day
 * it was written, and a `docs/capability-comparison-*.md` scan quotes the drift it found. A gate that rewrote
 * those would destroy the evidence that the drift happened. `README.md` is the one living document the gate
 * owns, and the only one that has to exist: `docs/` may be absent, or hold nothing but records.
 */
const HISTORICAL = [/^docs[\\/]validation-/, /^docs[\\/]capability-comparison-/];
async function livingDocs() {
  const found = ['README.md'];
  let names = [];
  try {
    names = await readdir(path.join(root, 'docs'));
  } catch (error) {
    // A repository whose `docs/` was emptied has no records to scan; that is not a failure of the gate.
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of names) if (name.endsWith('.md')) found.push(path.join('docs', name));
  return found
    .filter((file) => !HISTORICAL.some((pattern) => pattern.test(file)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/** The block between its markers, or the empty string when either marker is missing. */
function generatedBlock(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  return from === -1 || to === -1 ? '' : text.slice(from, to + end.length);
}
function replaceBlock(text, start, end, expected) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`README.md has no ${start} block`);
  return text.slice(0, from) + expected + text.slice(to + end.length);
}
async function check() {
  const value = await facts();
  const problems = [];
  const readme = await read('README.md');
  const blocks = [
    { start: START, end: END, expected: block(value), what: '生成事实块' },
    {
      start: SETTINGS_START,
      end: SETTINGS_END,
      expected: settingsBlock(),
      what: '生成设置表',
    },
  ];
  for (const { start, end, expected, what } of blocks) {
    const current = generatedBlock(readme, start, end);
    if (!current || normalize(current) !== normalize(expected))
      problems.push(`README.md 的${what}与代码不一致（运行 npm run docs:generate）`);
  }
  for (const file of await livingDocs()) {
    const text = await read(file);
    for (const [claim, why] of FORBIDDEN)
      if (text.includes(claim)) problems.push(`${file}: 出现已过时的说法「${claim}」（${why}）`);
  }
  // The description is a string the model reads: it has to agree with the schema beside it.
  const collect = collectTool();
  const description = String(collect.description);
  const maximum = collect.inputSchema?.properties?.waitMs?.maximum;
  for (const limit of [maximum, SUBAGENT_CEILINGS.collectWaitMs]) {
    if (limit && !description.includes(String(limit)))
      problems.push(`collect_subagents 的描述没有写明它的等待上限 ${limit}`);
  }
  return problems;
}
async function generate() {
  const value = await facts();
  const readme = await read('README.md');
  const rewritten = replaceBlock(
    replaceBlock(readme, START, END, block(value)),
    SETTINGS_START,
    SETTINGS_END,
    settingsBlock(),
  );
  await writeFile(path.join(root, 'README.md'), rewritten, 'utf8');
  console.log('docs: rewrote the README facts and settings blocks');
}

const mode = process.argv[2] ?? '--check';
if (mode === '--write' || mode === '--generate') await generate();
else {
  const problems = await check();
  if (problems.length) {
    console.error('docs:check failed:\n' + problems.map((line) => `  - ${line}`).join('\n'));
    process.exitCode = 1;
  } else console.log('docs:check passed');
}
