import { DEFAULT_MAX_OUTPUT_TOKENS } from './limits.ts';
import { BUILTIN_PROTOCOLS } from './index.ts';
import {
  PROMPT_CACHE_ALIASES,
  PROMPT_CACHE_MODES,
  routeSupports,
  type PromptCacheMode,
} from './cache-modes.ts';

/**
 * The settings this process owns: their defaults, their environment names, and what a mistyped name does.
 *
 * The defaults used to live wherever they were needed — `200` rounds and `1_000_000` tokens in the kernel,
 * again in the Host, `10_000_000` context characters in both, `120_000` ms timeouts in four places, and the
 * same numbers written out a fifth time in the CLI help text. Nothing compared them, so the help text could
 * say `default: 200` while the kernel used something else, and a new entry point could quietly pick its own
 * default. This module is the single owner: one table, one resolver, and one place that decides what a number
 * is allowed to be.
 *
 * The second half is the louder half. `YUANTU_MODELS` (a typo for `YUANTU_MODEL`) used to be ignored in
 * silence — the run simply used a different model than the operator asked for, which is the kind of failure
 * that only shows up much later. `environmentProblems` reports every `YUANTU_*` key this build does not know,
 * with the closest name it does know, and the entry points refuse to start on it.
 *
 * Keys used only by tests are listed too: the check is only honest if it knows about *every* key the project
 * sets, including the ones it sets for itself.
 */
export interface RunDefaults {
  maxContextChars: number;
  /**
   * The model's context window, when one has been declared.
   *
   * Deliberately without a default. A window is a fact about somebody else's endpoint: 1,000,000 for every
   * protocol meant a gateway serving 128k was measured against a number nobody had checked, and the run that
   * failed was blamed on the conversation. The entry points refuse a run that declares no window, and
   * `discoverModels()` is what produces a number worth declaring; the kernel treats an absent window as one it
   * cannot check a request against rather than inventing one.
   */
  maxContextTokens?: number;
  maxOutputTokens: number;
  /**
   * A run's *optional* wall-clock limit for one main model request, and only when an operator asks for one.
   *
   * There is deliberately no default: a model that keeps streaming is making progress, and cutting it off at
   * an arbitrary two minutes turns a slow answer into a failed run. What protects a run from a *stalled*
   * endpoint is the stream idle timeout, which is a different question and has its own number (`ProviderConfig`
   * `streamIdleTimeoutMs`, default 300000).
   *
   * It used to be a limit with a default that only the summary request read, which is how `RunDefaults` came
   * to own one number with two meanings and why the main request's timeout looked configured but never fired.
   */
  requestTimeoutMs?: number;
  /**
   * How long a compaction summary request may take. A summary is a bounded task with a bounded answer, so
   * unlike a main request it always has a limit.
   */
  summaryTimeoutMs: number;
  streamIdleTimeoutMs: number;
  /**
   * How many times a round's model request may be re-sent after a failure the retry policy calls transient
   * (`packages/protocol/retry.ts`).
   *
   * The count is per round, not per run, and the attempt is recorded before the wait, so the number of
   * attempts already made for a round is a fact in the log rather than a field in this process. That is what
   * makes it survive a restart: a host that dies mid-backoff does not come back with a fresh allowance.
   *
   * `0` means "never re-send": the first failure ends the run, which is what an operator wants when a request
   * is expensive, or when they would rather see the failure than the bill.
   */
  maxModelRetries: number;
  questionTimeoutMs: number;
  /**
   * How many sibling tool calls from one assistant message may be in flight at once.
   *
   * Only calls whose tool promises it (`Tool.isConcurrencySafe`) are ever overlapped, so this bounds a
   * scheduling decision rather than a count of effects; `1` is strictly serial execution and is what an
   * operator wants when a workspace cannot take two readers at once.
   */
  maxParallelToolCalls: number;
  /**
   * How long one runtime invariant check may take before it is reported as a violation.
   *
   * A check is user-supplied code running inside the run, so it needs the same bound as every other seam in
   * this runtime: a promise that holds must not hang the process that is verifying it.
   */
  invariantTimeoutMs: number;
  /**
   * How long one *external* hook command may run.
   *
   * An order of magnitude above the in-process tool-hook budget (5s) on purpose: an external hook pays
   * process startup before it does anything, and the things people hang off these events — a formatter, a
   * linter, a policy script that calls an API — routinely take seconds. Five seconds aborts a Node script
   * before it has finished parsing its arguments, which reads to the operator as "my hook is broken" rather
   * than "the budget is too small". It stays well under the 30s `close` budget so a hung hook cannot hold a
   * run open indefinitely.
   */
  hookTimeoutMs: number;
  /**
   * Characters of the parent's transcript a forked sub-agent starts with.
   *
   * A fork is only useful if it inherits the conversation, and it is only safe if that copy is bounded: a
   * long session carries base64 images and provider continuation state, and a child whose whole context is
   * spent on its parent's history has nothing left to think with. The copy takes the most recent messages and
   * drops the oldest, so what is lost is what the child is least likely to need.
   */
  forkTranscriptChars: number;
  /** Messages a forked sub-agent starts with, so a very long conversation of tiny messages is bounded too. */
  forkTranscriptMessages: number;
  /**
   * How many of the newest tool results are never shortened.
   *
   * Shortening is a projection of the transcript, not an edit to it, so this is about what the model can still
   * read without a second call rather than about what survives. The newest results are the ones the model is
   * reasoning over right now.
   */
  toolResultKeepRecent: number;
  /** Characters a shortened tool result keeps, split between its head and its tail. */
  toolResultShrinkTokens: number;
  /**
   * Code points a tool result may reach before its middle is dropped.
   *
   * Below the 24,000-character bound every tool result is produced with, which is what gives this pass a range
   * in which it can fire at all. Code points rather than bytes because the cut is a character cut: a byte budget
   * would spend three times as much on one script as on another (see `packages/core/prune.ts`).
   */
  toolResultPruneThresholdChars: number;
  /** Code points a pruned result keeps at its head, where a log says what it was doing. */
  toolResultPruneHeadChars: number;
  /** Code points a pruned result keeps at its tail, where a log says how it ended. */
  toolResultPruneTailChars: number;
  /**
   * Share of the window at which old tool results are shortened.
   *
   * This is the "in good time" part: waiting until a request does not fit means shortening under pressure and
   * re-sending a request that already failed its budget check. A percentage rather than a token count keeps it
   * meaningful across window sizes.
   */
  contextShrinkPercent: number;
}
/**
 * The numbers a run uses when nothing overrides them. The context defaults are imported from the protocol so
 * there is exactly one statement of them.
 */
export const RUN_DEFAULTS = Object.freeze({
  /**
   * What a run is bounded by, and what it deliberately is not.
   *
   * Not rounds: the model decides when it is done, and a fixed number of rounds is a guess about how much work
   * a task is — wrong in both directions. Not a cumulative token allowance either: an allowance counts the same
   * conversation again every round, so it runs out in proportion to rounds × context rather than to work done,
   * and a long task fails for having talked a lot. What limits spend is the provider's own quota plus the
   * operator's choice of model; what limits a single request is the window below; what limits the rounds nobody
   * asked for is the goal that asked for them (`GOAL_DEFAULTS.maxGoalRounds`).
   */
  maxContextChars: 10_000_000,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  summaryTimeoutMs: 120_000,
  streamIdleTimeoutMs: 300_000,
  /**
   * Five, which is the same allowance the LLM layer's own retry policy resolves to by default. A round that
   * has failed five times is usually failing for a reason re-sending cannot fix, and each attempt is a bill
   * for the same answer.
   */
  maxModelRetries: 5,
  questionTimeoutMs: 120_000,
  /**
   * Four, not the ten a batch of reads could use: the tools that opt in are local file, git and session
   * reads, where the win is overlapping I/O waits and the cost of going wider is disk and handle contention
   * on one machine. An operator with a batch of network reads and a reason to overlap more raises it.
   */
  maxParallelToolCalls: 4,
  invariantTimeoutMs: 5_000,
  hookTimeoutMs: 30_000,
  forkTranscriptChars: 120_000,
  forkTranscriptMessages: 200,
  toolResultKeepRecent: 6,
  toolResultShrinkTokens: 400,
  /**
   * Just below the 24,000-character bound every tool result is produced with, so this pass has a range in which
   * it can fire at all — a threshold above that bound would be a setting that can never do anything.
   *
   * The head keeps most of the budget because the two ends of a build log or a diff are not equally useful: the
   * top says what the command was and what it started doing, the bottom says how it ended, and the middle is the
   * part nobody reads twice. The three numbers satisfy `head + marker + tail <= threshold`, which is the
   * invariant that makes one pass land inside the budget instead of near it (`assertPrunePolicy`).
   */
  toolResultPruneThresholdChars: 20_000,
  toolResultPruneHeadChars: 12_000,
  toolResultPruneTailChars: 4_000,
  contextShrinkPercent: 60,
} as const) satisfies RunDefaults;
export interface EnvironmentSpec {
  kind: 'string' | 'boolean' | 'number' | 'enum';
  values?: readonly string[];
  range?: readonly [number, number];
  description: string;
  /**
   * A rule the four kinds cannot express, returning what is wrong with the value or nothing.
   *
   * `YUANTU_PROMPT_CACHE` is why this exists. It grew from a boolean into four words, and its older spellings
   * still have to be accepted — which an `enum` cannot do, because the table compares against literals. Declaring
   * it `string` instead would have been the quiet failure this whole table exists to prevent: the environment
   * check would stop noticing a typo in it, so `YUANTU_PROMPT_CACHE=maybe` would start a run instead of failing
   * one. The rule lives here, beside the value it validates, so "what is legal" still has exactly one owner.
   */
  validate?: (value: string) => string | undefined;
  /**
   * What to write in a value column when the four kinds cannot say it.
   *
   * `string` is the honest answer for a setting whose shape is "some text", and a useless one for a setting whose
   * text has to be one of four words: the settings page would label `YUANTU_PROMPT_CACHE` as `string` while
   * refusing everything except the modes. `settingShape` prefers this when a setting has it, so the value column,
   * the README table and the CLI's `env` all print the vocabulary rather than the type.
   */
  shape?: string;
}
/**
 * Every setting an operator may set, and the shape it has to have.
 *
 * `kind` is what makes this typed rather than a list of names: `enum` and `boolean` values are validated
 * here instead of at five call sites, and `range` is the bound the setters used to repeat.
 */
export const ENVIRONMENT = {
  YUANTU_API_KEY: { kind: 'string', description: '模型 API 密钥' },
  YUANTU_BASE_URL: { kind: 'string', description: '模型端点' },
  YUANTU_MODEL: { kind: 'string', description: '模型 ID' },
  YUANTU_PROTOCOL: {
    kind: 'enum',
    // `BUILTIN_PROTOCOLS` rather than three literals: the parser, the help text and the provider registry
    // all answer "which protocol names exist", and a second copy is how the retry range drifted before.
    values: BUILTIN_PROTOCOLS,
    description: '协议适配器',
  },
  YUANTU_CONNECTION_ID: { kind: 'string', description: '设置文件中的连接名（仅标注）' },
  YUANTU_SUPPORTS_VISION: { kind: 'boolean', description: '该模型是否接受图片' },
  YUANTU_PROMPT_CACHE: {
    kind: 'string',
    // The four modes and the spellings the older boolean accepted. A `string` kind rather than an `enum` because
    // the aliases have to be translated before the value is compared, so the rule is `validate` below rather than
    // a literal list — and it lives in the table, not in the adapter, so the environment check still refuses a
    // typo at startup instead of letting it through as an opaque string.
    validate: (value) =>
      promptCacheMode(value)
        ? undefined
        : `must be one of ${PROMPT_CACHE_MODES.join(', ')} (or ${Object.keys(PROMPT_CACHE_ALIASES).join(' / ')}); got "${value}"`,
    shape: PROMPT_CACHE_MODES.join(' / '),
    description: `提示缓存的粒度：${PROMPT_CACHE_MODES.join(' / ')}；auto 按路由声明的能力选，其余三种照字面执行，off 不发送缓存字段（旧值 0 / false 等价于 off，1 / true 等价于 auto）`,
  },
  YUANTU_STREAM_IDLE_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 3_600_000],
    description: '流式空闲超时（毫秒）',
  },
  YUANTU_MAX_RETRIES: {
    kind: 'number',
    range: [0, 5],
    description: '每个 step 边界重发模型请求的次数上限（0 = 不重试）',
  },
  YUANTU_MAX_CONTEXT_TOKENS: {
    kind: 'number',
    range: [1, 100_000_000],
    description: '模型上下文窗口',
  },
  YUANTU_MAX_OUTPUT_TOKENS: { kind: 'number', range: [1, 10_000_000], description: '单次输出上限' },
  /**
   * The windows of the endpoint's *other* models, as JSON: `{"<model id>": {"contextWindow": n}}`.
   *
   * Written by the desktop (the model rows of an endpoint group) and read where a run resolves a route's
   * window, because one declaration answers for one model and a pre-step policy can re-aim a round at another.
   * The shape is checked by the reader rather than here: it is a map of records, not one of the scalar kinds
   * this table declares.
   */
  YUANTU_MODEL_CAPACITIES: {
    kind: 'string',
    description: '同一端点其他模型的窗口声明（JSON）',
  },
  YUANTU_AUTO_COMPACT_TOKENS: {
    kind: 'number',
    range: [1, 100_000_000],
    description: '提前压缩阈值',
  },
  YUANTU_REQUEST_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 3_600_000],
    description: '单次模型请求超时',
  },
  YUANTU_MAX_PARALLEL_TOOLS: {
    kind: 'number',
    range: [1, 32],
    description:
      '一条助手消息里可同时运行的工具调用上限（1 = 严格串行；只对声明了并行安全的工具生效）',
  },
  YUANTU_QUESTION_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 3_600_000],
    description: '模型向用户提问的等待超时（毫秒）',
  },
  YUANTU_TOOL_TIMEOUT_MS: {
    kind: 'number',
    range: [0, 3_600_000],
    description: '单次工具调用的墙钟上限（毫秒，0 = 不设上限）',
  },
  YUANTU_INVARIANT_TIMEOUT_MS: {
    kind: 'number',
    range: [100, 600_000],
    description: '单条运行时不变量检查的超时（毫秒）',
  },
  YUANTU_WORKSPACE: { kind: 'string', description: '工作区目录' },
  YUANTU_SANDBOX: {
    kind: 'enum',
    values: ['host', 'docker', 'sbx', 'windows'],
    description:
      '命令沙箱模式（桌面：新会话从哪个模式开始——档位按会话选择，改动即时生效，不改写这个值）',
  },
  YUANTU_SANDBOX_HOOK: {
    kind: 'enum',
    values: ['host', 'docker', 'sbx', 'windows'],
    description:
      '钩子用的沙箱模式（默认跟随 YUANTU_SANDBOX；容器模式装不了钩子，所以只能显式写 host）',
  },
  YUANTU_SANDBOX_IMAGE: { kind: 'string', description: '沙箱镜像' },
  // Internal, and registered for the same reason the test keys below are: the check has to know every YUANTU_*
  // name the project itself uses. This one never reaches a user's environment — the Windows launcher is handed
  // its per-command payload (command line, cwd, environment block) in this variable instead of in the
  // PowerShell script text, because a script whose text changes per command is re-scanned by the platform on
  // every command, which measured 2.1s against 0.43s for a script whose text never changes.
  YUANTU_SANDBOX_SPEC: { kind: 'string', description: '（内部）沙箱启动器的单次命令载荷' },
  YUANTU_PTY: {
    kind: 'string',
    description: '终端（terminal_* 工具）使用的 PTY 后端名，默认为内置的 node-pty',
  },
  YUANTU_ALLOW_PRIVATE_NETWORK: { kind: 'boolean', description: '是否允许访问私有网段' },
  YUANTU_FS_OBSERVATION: {
    kind: 'boolean',
    description: '改动文件前是否要求本运行已读过该文件（默认开启，关闭则不检查）',
  },
  YUANTU_TOOL_MODE: {
    kind: 'enum',
    values: ['native', 'ptc'],
    description: '工具下发方式：native 逐个下发，ptc 折成 run_code + 生成 SDK',
  },
  YUANTU_PERMISSION_POLICY: { kind: 'string', description: '权限策略文件路径' },
  YUANTU_HOOKS_MODULE: { kind: 'string', description: '扩展钩子模块路径' },
  YUANTU_HOOK_BRIDGE: {
    kind: 'boolean',
    description: '是否加载工作区里声明的外部钩子（.claude/settings.json、.yuantu/hooks.json）',
  },
  YUANTU_HOOK_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 600_000],
    description: '单条外部钩子命令的超时（毫秒）',
  },
  YUANTU_FORK_TRANSCRIPT_CHARS: {
    kind: 'number',
    range: [1_000, 10_000_000],
    description: '分叉子代理继承的父会话转录字符上限',
  },
  YUANTU_FORK_TRANSCRIPT_MESSAGES: {
    kind: 'number',
    range: [1, 10_000],
    description: '分叉子代理继承的父会话消息条数上限',
  },
  YUANTU_SUBAGENT_MODELS: {
    kind: 'string',
    description: '额外的可委派模型 id（逗号分隔），供 list_subagent_models 列出',
  },
  YUANTU_TOOL_RESULT_KEEP_RECENT: {
    kind: 'number',
    range: [0, 100],
    description: '末尾永不缩短的工具结果条数',
  },
  YUANTU_TOOL_RESULT_SHRINK_TOKENS: {
    kind: 'number',
    // A token budget rather than a character one: 1,200 characters is about 400 tokens of English and about
    // 1,200 of Chinese, so the old unit spent three times as much context on one conversation as on another.
    range: [100, 32_000],
    description: '缩短后保留的 token 数（头尾各半）',
  },
  YUANTU_CONTEXT_SHRINK_PERCENT: {
    kind: 'number',
    range: [10, 95],
    description: '占窗口（或提前压缩阈值）百分之多少时开始缩短旧工具结果',
  },
  YUANTU_TOOL_RESULT_PRUNE_THRESHOLD_CHARS: {
    kind: 'number',
    // Code points, and above the 24,000-character bound a tool result is produced with: this pass is a backstop
    // for results that grew past that, not a second pass over everything shortening already handles.
    range: [1_000, 10_000_000],
    description: '旧工具结果超过多少字符时丢弃中段（保留头尾）',
  },
  YUANTU_TOOL_RESULT_PRUNE_HEAD_CHARS: {
    kind: 'number',
    range: [0, 1_000_000],
    description: '丢弃中段时在开头保留的字符数',
  },
  YUANTU_TOOL_RESULT_PRUNE_TAIL_CHARS: {
    kind: 'number',
    range: [0, 1_000_000],
    description: '丢弃中段时在结尾保留的字符数',
  },
  YUANTU_MCP_OAUTH_DIR: { kind: 'string', description: 'MCP OAuth 令牌目录' },
  YUANTU_CREDENTIALS_FILE: {
    kind: 'string',
    description: '凭据文件路径（默认 ~/.yuantu/credentials.json；环境变量中的密钥优先于它）',
  },
  YUANTU_MEMORY_DIR: { kind: 'string', description: '用户级记忆目录' },
  YUANTU_KNOWLEDGE_DB: { kind: 'string', description: '知识库数据库路径' },
  YUANTU_REPO_MAP: { kind: 'enum', values: ['on', 'off'], description: '是否注入结构大纲' },
  YUANTU_LSP_AFTER_EDIT: { kind: 'boolean', description: '编辑后是否附加诊断' },
  YUANTU_SUBAGENTS: { kind: 'boolean', description: '是否启用子代理委派' },
  YUANTU_SUBAGENT_CONCURRENCY: { kind: 'number', range: [1, 16], description: '子代理并发上限' },
  YUANTU_SUBAGENT_TIMEOUT_MS: {
    kind: 'number',
    range: [0, 3_600_000],
    description:
      '子代理无进展（卡住）多久后停止（毫秒，0 = 不设看门狗；只要子代理还在产出就会重新计时，长任务不会被它切断）',
  },
  YUANTU_SEARCH_PROVIDER: { kind: 'string', description: '联网搜索提供方' },
  YUANTU_SEARCH_API_KEY: { kind: 'string', description: '联网搜索密钥' },
  YUANTU_SEARCH_BASE_URL: { kind: 'string', description: '联网搜索端点' },
  YUANTU_WORKFLOWS: { kind: 'boolean', description: '是否启用持久任务调度' },
  /**
   * Whether the Host spends one small model call naming a session before its first reply.
   *
   * On by default, because a named session is what makes the session list usable. It is a switch rather than an
   * unconditional behaviour because that call is an **extra request to the configured endpoint**: a fixture that
   * scripts one response per request sees it, a metered endpoint bills it, and an endpoint that is already down
   * pays a timeout for it before the run the user actually asked for starts. Turning it off leaves every session
   * on its first-message fallback title, which is what a deployment with no spare call wants.
   */
  YUANTU_SESSION_TITLES: {
    kind: 'boolean',
    description: '是否用一次模型调用为会话生成标题（默认开启）',
  },
  YUANTU_WORKFLOW_INTERVAL_MS: {
    kind: 'number',
    range: [1_000, 86_400_000],
    description: '调度器两次查看之间的最长间隔（到期时刻会直接唤醒它；这里是上限与兜底）',
  },
  YUANTU_LIBREOFFICE_PATH: {
    kind: 'string',
    description: '可选 Office PDF 预览的 LibreOffice 命令行程序路径（Windows 建议 soffice.com）',
  },
  // Test-only keys, listed because the check has to know every YUANTU_* name the project itself sets.
  YUANTU_NODE_PATH: { kind: 'string', description: '（测试）子进程使用的 node 路径' },
  YUANTU_QA_DIR: { kind: 'string', description: '（测试）QA 产物目录' },
  YUANTU_QA_SCREENSHOT: { kind: 'string', description: '（测试）是否截图' },
  YUANTU_MCP_TEST_SECRET: { kind: 'string', description: '（测试）MCP 夹具密钥' },
  YUANTU_TEST_DOCKER: { kind: 'string', description: '（测试）Docker 沙箱可用性' },
  YUANTU_TEST_SBX: { kind: 'string', description: '（测试）sbx 沙箱可用性' },
} as const satisfies Record<string, EnvironmentSpec>;
export type EnvironmentKey = keyof typeof ENVIRONMENT;
/**
 * The one parser for `YUANTU_PROMPT_CACHE`, and the one list of what it accepts.
 *
 * It lives here rather than in the provider layer because the setting's own value is not the whole answer: `auto`
 * has to be resolved against the route before anything can be sent, and that resolution is a second owner of the
 * same vocabulary. Keeping the parse and the vocabulary together is what stops "which modes exist" from being
 * answered twice.
 */
export function promptCacheMode(value: unknown): PromptCacheMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toLowerCase();
  return PROMPT_CACHE_ALIASES[text] ?? PROMPT_CACHE_MODES.find((mode) => mode === text);
}
/** What `auto` resolves to, and therefore what a connection that says nothing gets. */
export function defaultPromptCacheMode(protocol: string): PromptCacheMode {
  if (routeSupports(protocol, 'prompt-cache-blocks')) return 'blocks';
  if (routeSupports(protocol, 'prompt-cache-key')) return 'key-only';
  return 'off';
}
/**
 * The four model runtime limits, under the name the settings UI gives each one.
 *
 * One setting has two ends — the variable an operator exports and the field of a saved model row in the
 * desktop's settings file — and they had drifted into three different ranges: `apps/desktop/model-settings.ts`
 * accepted a context window in `[1024, 2_000_000]`, `apps/desktop/settings-contract.ts` wrote those numbers
 * again, and `ENVIRONMENT` above accepts `[1, 100_000_000]`. The visible symptom was the worst kind: a value
 * the CLI honoured was *silently ignored* by the desktop, which fell back to "no window declared" with nothing
 * on screen to say so. The range lives in `ENVIRONMENT` and nowhere else; this map is how the desktop's env
 * reader, its settings contract and its form bounds all find it.
 *
 * The keys are strings and the fields are identifiers because the two ends are named differently on purpose:
 * `YUANTU_MAX_CONTEXT_TOKENS` is an operator-facing name, `maxContextTokens` is a JSON field and an input's
 * `data-field`.
 */
export const MODEL_LIMIT_KEYS = {
  maxContextTokens: 'YUANTU_MAX_CONTEXT_TOKENS',
  autoCompactTokens: 'YUANTU_AUTO_COMPACT_TOKENS',
  maxOutputTokens: 'YUANTU_MAX_OUTPUT_TOKENS',
  streamIdleTimeoutMs: 'YUANTU_STREAM_IDLE_TIMEOUT_MS',
} as const satisfies Record<string, EnvironmentKey>;
export type ModelLimitField = keyof typeof MODEL_LIMIT_KEYS;
/** The one range for a model runtime limit, read from the table that declares it. */
export function modelLimitRange(field: ModelLimitField): readonly [number, number] {
  return ENVIRONMENT[MODEL_LIMIT_KEYS[field]].range;
}
/**
 * How a person writes a value of this kind, in the words the parser actually enforces.
 *
 * Three readers ask this question — the CLI's `env` command, the generated settings table in the README, and the
 * desktop's settings page — and the first two had already grown their own copy that had to agree word for word.
 * The strings are ASCII on purpose: they are a shape rather than a sentence, so they read the same in every
 * language the interface is written in.
 */
export function settingShape(spec: EnvironmentSpec): string {
  // A setting that carries its own vocabulary says so: "string" is what the parser accepts in the abstract, and
  // the four words it actually accepts are what a person needs. Declared by the setting because only the setting
  // knows -- the kinds cannot express "one of these, or the two spellings the last version used".
  if (spec.shape) return spec.shape;
  if (spec.kind === 'enum') return spec.values!.join(' / ');
  if (spec.kind === 'number') return `${spec.range![0]}–${spec.range![1]}`;
  if (spec.kind === 'boolean') return '0 / 1';
  return 'string';
}
/**
 * Whether a setting's *value* is a credential, so it may only be reported as present or absent.
 *
 * The rule is shared rather than copied because the two readers that show values — the CLI's `env` command and
 * the desktop's settings page — must agree about which ones are secrets; a copy is how one of them starts
 * printing a key. Matching on the name is deliberately blunt: a false positive costs a person one `echo`, and a
 * false negative prints an API key into scrollback or into whatever collects a terminal's output.
 *
 * The `_MS` / `_TOKENS` exemption is what keeps the rule about credentials rather than about the word "token":
 * `YUANTU_TOOL_RESULT_SHRINK_TOKENS` and `YUANTU_INVARIANT_TIMEOUT_MS` are budgets and durations, and a rule
 * that hid them would be hiding the numbers an operator came to look at.
 */
export function isCredentialSetting(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && !/_(MS|TOKENS)$/.test(name);
}
export interface EnvironmentProblem {
  key: string;
  problem: string;
  /** The closest known name, when one is close enough to be worth suggesting. */
  suggestion?: string;
}
/** Levenshtein distance, bounded to the lengths this is used for (env names are short). */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [
    index,
    ...Array(b.length).fill(0),
  ]);
  for (let column = 1; column <= b.length; column++) rows[0]![column] = column;
  for (let row = 1; row <= a.length; row++)
    for (let column = 1; column <= b.length; column++)
      rows[row]![column] = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
  return rows[a.length]![b.length]!;
}
function closest(key: string): string | undefined {
  const ranked = Object.keys(ENVIRONMENT)
    .map((name) => ({ name, distance: distance(key, name) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(key.length / 4)) ? best.name : undefined;
}
function invalidValue(key: EnvironmentKey, value: string): string | undefined {
  const spec: EnvironmentSpec = ENVIRONMENT[key];
  // The custom rule first: it is the one that knows about this setting's own vocabulary, including the spellings
  // an earlier shape accepted.
  if (spec.validate) return spec.validate(value);
  if (spec.kind === 'boolean') {
    const parsed = value.trim().toLowerCase();
    return ['0', '1', 'true', 'false'].includes(parsed)
      ? undefined
      : `${key} must be 0, 1, true or false`;
  }
  if (spec.kind === 'enum' && !spec.values!.includes(value))
    return `${key} must be one of ${spec.values!.join(', ')}`;
  if (spec.kind === 'number') {
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed))
      return `${key} must be a number (got "${value}")`;
    const [low, high] = spec.range!;
    if (!Number.isSafeInteger(parsed) || parsed < low || parsed > high)
      return `${key} must be an integer between ${low} and ${high} (got "${value}")`;
  }
  return undefined;
}
/**
 * The typed value of one setting, or `undefined` when it is not set.
 *
 * This is the only reader there is: `environmentProblems` asks it what is wrong with a value and every
 * consumer of a setting goes through it, so a rule cannot exist in two places and drift. An empty value
 * counts as "not set" rather than as an invalid number, because `VAR=` in a script means exactly that and
 * every reader here has always treated it that way.
 */
export function parseSetting(
  env: NodeJS.ProcessEnv,
  key: EnvironmentKey,
): string | number | boolean | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const problem = invalidValue(key, raw);
  if (problem) throw new Error(problem);
  const spec: EnvironmentSpec = ENVIRONMENT[key];
  if (spec.kind === 'number') return Number(raw);
  if (spec.kind === 'boolean') return ['1', 'true'].includes(raw.trim().toLowerCase());
  return raw;
}
/**
 * Everything wrong with an environment: keys this build does not know, and known keys whose value cannot be
 * used. Returned rather than thrown so a caller can show all of them at once — an operator who mistyped two
 * names should not have to fix them one restart at a time.
 */
export function environmentProblems(env: NodeJS.ProcessEnv = process.env): EnvironmentProblem[] {
  const problems: EnvironmentProblem[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('YUANTU_') || value === undefined || value === '') continue;
    if (!(key in ENVIRONMENT)) {
      const suggestion = closest(key);
      problems.push({
        key,
        problem: `unknown setting${suggestion ? `; did you mean ${suggestion}?` : ''}`,
        ...(suggestion ? { suggestion } : {}),
      });
      continue;
    }
    const problem = invalidValue(key as EnvironmentKey, value);
    if (problem) problems.push({ key, problem });
  }
  return problems.sort((left, right) => left.key.localeCompare(right.key));
}
/** Refuses to start on a broken environment, saying everything that is wrong with it. */
export function assertEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const problems = environmentProblems(env);
  if (!problems.length) return;
  throw new Error(
    `Invalid environment configuration:\n${problems.map((entry) => `  - ${entry.key}: ${entry.problem}`).join('\n')}`,
  );
}
/**
 * A run's limits with the shared defaults applied and every bound checked in one place.
 *
 * Every number here bounds *one request* (its window, its output cap, its timeout) or *the run's shape* (its
 * parallel tool calls, its stream idle timeout). None of them is a cumulative allowance, which is why there is
 * nothing to validate against `maxContextTokens`: a second window's worth of requests is not an overspend, it
 * is a longer conversation. The run's *round* count is not here either, because a run has no round cap: the
 * rounds nobody asked for are counted by the goal that asked for them.
 */
export function resolveRunLimits(options: Partial<RunDefaults> = {}): RunDefaults {
  const resolved: RunDefaults = {
    maxContextChars: options.maxContextChars ?? RUN_DEFAULTS.maxContextChars,
    // Absent stays absent: filling it here would be the same guess one layer down.
    ...(options.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: options.maxContextTokens }),
    maxOutputTokens: options.maxOutputTokens ?? RUN_DEFAULTS.maxOutputTokens,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    summaryTimeoutMs: options.summaryTimeoutMs ?? RUN_DEFAULTS.summaryTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? RUN_DEFAULTS.streamIdleTimeoutMs,
    maxModelRetries: options.maxModelRetries ?? RUN_DEFAULTS.maxModelRetries,
    questionTimeoutMs: options.questionTimeoutMs ?? RUN_DEFAULTS.questionTimeoutMs,
    maxParallelToolCalls: options.maxParallelToolCalls ?? RUN_DEFAULTS.maxParallelToolCalls,
    invariantTimeoutMs: options.invariantTimeoutMs ?? RUN_DEFAULTS.invariantTimeoutMs,
    hookTimeoutMs: options.hookTimeoutMs ?? RUN_DEFAULTS.hookTimeoutMs,
    forkTranscriptChars: options.forkTranscriptChars ?? RUN_DEFAULTS.forkTranscriptChars,
    forkTranscriptMessages: options.forkTranscriptMessages ?? RUN_DEFAULTS.forkTranscriptMessages,
    toolResultKeepRecent: options.toolResultKeepRecent ?? RUN_DEFAULTS.toolResultKeepRecent,
    toolResultShrinkTokens: options.toolResultShrinkTokens ?? RUN_DEFAULTS.toolResultShrinkTokens,
    toolResultPruneThresholdChars:
      options.toolResultPruneThresholdChars ?? RUN_DEFAULTS.toolResultPruneThresholdChars,
    toolResultPruneHeadChars:
      options.toolResultPruneHeadChars ?? RUN_DEFAULTS.toolResultPruneHeadChars,
    toolResultPruneTailChars:
      options.toolResultPruneTailChars ?? RUN_DEFAULTS.toolResultPruneTailChars,
    contextShrinkPercent: options.contextShrinkPercent ?? RUN_DEFAULTS.contextShrinkPercent,
  };
  /**
   * Every limit is at least one, because zero of a round, a message count or a timeout is a misconfiguration
   * rather than a choice. Two exceptions, both of which are policies an operator may hold deliberately:
   * shortening every old result is what "smallest possible context" means (`toolResultKeepRecent`), and
   * `maxModelRetries: 0` says a failed request is a failed run — never re-send it.
   */
  for (const [name, value] of Object.entries(resolved)) {
    // `requestTimeoutMs` is absent unless an operator asked for one, and an absent limit is not a bad value.
    if (value === undefined) continue;
    const floor = name === 'toolResultKeepRecent' || name === 'maxModelRetries' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < floor) throw new Error(`Invalid ${name}`);
  }
  return resolved;
}
