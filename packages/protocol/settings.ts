import { DEFAULT_MAX_OUTPUT_TOKENS } from './limits.ts';
import { assertPrunePolicyFits } from './prune-policy.ts';
import { BUILTIN_PROTOCOLS } from './index.ts';
import { editDistance } from './similar-names.ts';
import {
  PROMPT_CACHE_ALIASES,
  PROMPT_CACHE_MODES,
  routeSupports,
  type PromptCacheMode,
} from './cache-modes.ts';

/**
 * The settings this process owns: their defaults, environment names, and validation. This module is
 * the single owner of every default so entry points and help text cannot drift apart.
 *
 * `environmentProblems` reports every unknown `YUANTU_*` key with the closest known name, and entry
 * points refuse to start on it. Test-only keys are listed too, so the check knows every key the
 * project sets.
 */
export interface RunDefaults {
  maxContextChars: number;
  /**
   * The model's context window, when declared. Deliberately no default: the window is a fact about
   * the endpoint. Entry points resolve it from metadata or a local budget; when absent, the kernel
   * runs without token-window checks.
   */
  maxContextTokens?: number;
  maxOutputTokens: number;
  /**
   * Optional wall-clock limit for one main model request; no default, since a streaming model is
   * making progress. Stalled endpoints are caught by `ProviderConfig.streamIdleTimeoutMs` instead.
   */
  requestTimeoutMs?: number;
  /**
   * How long a compaction summary request may take. A summary is a bounded task with a bounded answer, so
   * unlike a main request it always has a limit.
   */
  summaryTimeoutMs: number;
  streamIdleTimeoutMs: number;
  /** How long the endpoint may take to send its response headers; the provider reads its connection's value. */
  responseHeadersTimeoutMs: number;
  /**
   * Re-sends allowed per round after a transient failure (`packages/protocol/retry.ts`). Attempts
   * are recorded before the wait, so a restarted host does not get a fresh allowance. `0` means
   * never re-send.
   */
  maxModelRetries: number;
  /** How many times an attempt that produced no bytes may be re-sent, beyond `maxModelRetries`. `0` is off. */
  zeroByteRetries: number;
  /**
   * Model time a run may spend investigating before it is pushed to edit: a nudge at half this
   * value, tool withdrawal at the full value.
   */
  investigationMs: number;
  questionTimeoutMs: number;
  /**
   * A run's total budget: rounds, wall-clock time excluding waits on a person, and model tokens
   * (output plus uncached input). `0` turns one off. A backstop against runaway runs, not a task
   * size; reaching it ends the run `limited` at a round boundary.
   *
   * Cached reads are excluded so long conversations do not hit the token cap from re-reading
   * context. Rounds are off by default because a round count cuts long tasks short;
   * `tests/failure-codes.test.ts` holds the 300-round run that must still finish.
   */
  maxRunRounds: number;
  maxRunMs: number;
  maxRunTokens: number;
  /**
   * Sibling tool calls from one assistant message that may run at once. Only
   * `Tool.isConcurrencySafe` calls overlap; `1` is strictly serial.
   */
  maxParallelToolCalls: number;
  /** How long one runtime invariant check may take before it counts as a violation. */
  invariantTimeoutMs: number;
  /**
   * How long one external hook command may run. Well above the in-process tool-hook budget (5s)
   * because external hooks pay process startup, and well below the 30s `close` budget.
   */
  hookTimeoutMs: number;
  /**
   * Characters of the parent's transcript a forked sub-agent starts with. The newest messages are
   * kept so the child still has room to work.
   */
  forkTranscriptChars: number;
  /** Messages a forked sub-agent starts with, so a very long conversation of tiny messages is bounded too. */
  forkTranscriptMessages: number;
  /** How many of the newest tool results are never shortened. Shortening is a view, not an edit. */
  toolResultKeepRecent: number;
  /** Characters a shortened tool result keeps, split between its head and its tail. */
  toolResultShrinkTokens: number;
  /**
   * Code points a tool result may reach before its middle is dropped. Below the 24,000-character
   * production bound so it can fire; see `packages/core/context/prune.ts`.
   */
  toolResultPruneThresholdChars: number;
  /** Code points a pruned result keeps at its head, where a log says what it was doing. */
  toolResultPruneHeadChars: number;
  /** Code points a pruned result keeps at its tail, where a log says how it ended. */
  toolResultPruneTailChars: number;
  /**
   * Share of the window at which old tool results are shortened, so shortening happens before a
   * request no longer fits.
   */
  contextShrinkPercent: number;
}
/**
 * The numbers a run uses when nothing overrides them. The context defaults are imported from the protocol so
 * there is exactly one statement of them.
 */
export const RUN_DEFAULTS = Object.freeze({
  /**
   * Per-request bound. There is no round cap or cumulative token allowance here; the run-total
   * backstops are `maxRunRounds`/`maxRunMs`/`maxRunTokens`, and goal rounds are counted by
   * `GOAL_DEFAULTS.maxGoalRounds`.
   */
  maxContextChars: 10_000_000,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  summaryTimeoutMs: 120_000,
  streamIdleTimeoutMs: 300_000,
  /**
   * Same as `streamIdleTimeoutMs`, so a connection naming neither waits the same for both. The
   * provider reads its connection's value; this is the run-level default.
   */
  responseHeadersTimeoutMs: 300_000,
  /** Matches the LLM layer's default retry policy. */
  maxModelRetries: 5,
  /** Off by default: a zero-byte failure may still have been billed. The evaluation enables one. */
  zeroByteRetries: 0,
  /** 240 s, with the nudge at 120 s. */
  investigationMs: 240_000,
  questionTimeoutMs: 120_000,
  maxRunRounds: 0,
  maxRunMs: 2 * 60 * 60 * 1000,
  maxRunTokens: 20_000_000,
  /**
   * Only reads opt in to overlap; writes, commands and permissioned tools stay exclusive. Override
   * with `YUANTU_MAX_PARALLEL_TOOLS`.
   */
  maxParallelToolCalls: 8,
  invariantTimeoutMs: 5_000,
  hookTimeoutMs: 30_000,
  forkTranscriptChars: 120_000,
  forkTranscriptMessages: 200,
  toolResultKeepRecent: 6,
  toolResultShrinkTokens: 400,
  /**
   * Just below the 24,000-character production bound so this pass can fire. The head gets most of
   * the budget. `head + marker + tail <= threshold` must hold (`assertPrunePolicy`).
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
   * A rule the four kinds cannot express; returns what is wrong with the value, or nothing. Exists
   * for `YUANTU_PROMPT_CACHE`, whose older spellings an `enum` cannot accept.
   */
  validate?: (value: string) => string | undefined;
  /**
   * The value shape to display when the kind cannot say it (e.g. the four cache modes instead of
   * `string`). Used by `settingShape`.
   */
  shape?: string;
}
/**
 * Every setting an operator may set and its shape. `enum`, `boolean` and `range` are validated
 * here, not at call sites.
 */
export const ENVIRONMENT = {
  YUANTU_API_KEY: { kind: 'string', description: '模型 API 密钥' },
  YUANTU_BASE_URL: { kind: 'string', description: '模型端点' },
  YUANTU_MODEL: { kind: 'string', description: '模型 ID' },
  YUANTU_PROTOCOL: {
    kind: 'enum',
    // `BUILTIN_PROTOCOLS` so the parser, help text and provider registry share one list.
    values: BUILTIN_PROTOCOLS,
    description: '协议适配器',
  },
  YUANTU_CONNECTION_ID: { kind: 'string', description: '设置文件中的连接名（仅标注）' },
  YUANTU_SUPPORTS_VISION: { kind: 'boolean', description: '该模型是否接受图片' },
  YUANTU_STRICT_TOOLS: {
    kind: 'boolean',
    description:
      'Anthropic 协议下给可表达的工具发送 strict: true，由端点保证参数符合 schema；模型或网关不支持时会整次请求失败，默认关闭',
  },
  YUANTU_DEEPSEEK_COMPAT: {
    kind: 'enum',
    values: ['auto', 'on', 'off'],
    description:
      'DeepSeek 原生历史兼容：auto 仅识别官方端点的已知模型；on 显式声明网关支持思考回传与历史系统提示更新；off 禁用',
  },
  YUANTU_PROMPT_CACHE: {
    kind: 'string',
    // A `string` kind with `validate`, because older boolean spellings must be translated before
    // comparing. Kept in the table so typos are still refused at startup.
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
  /**
   * Time to response headers, separate from the stream idle clock. Unset means the same as the idle
   * timeout.
   */
  YUANTU_RESPONSE_HEADERS_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 3_600_000],
    description: '等待响应头的超时（毫秒；缺省与流空闲超时相同）',
  },
  YUANTU_MAX_RETRIES: {
    kind: 'number',
    range: [0, 5],
    description: '每个 step 边界重发模型请求的次数上限（0 = 不重试）',
  },
  /**
   * How long a run may investigate before it is asked to edit; tools are withdrawn at this value
   * and the warning fires at half, so the two cannot be misordered.
   */
  YUANTU_INVESTIGATION_MS: {
    kind: 'number',
    range: [1_000, 3_600_000],
    description: '调查到动手的时间阈值（毫秒；提醒取一半，工具轮数阈值 12/20 不变）',
  },
  /**
   * Re-sends for attempts that produced no bytes, beyond `YUANTU_MAX_RETRIES`. Separate because
   * normal retries also cover partial streams. Product default is zero.
   */
  YUANTU_ZERO_BYTE_RETRIES: {
    kind: 'number',
    range: [0, 3],
    description: '零字节失败的独立重发次数（0 = 不重发；只对完全没有收到字节的失败生效）',
  },
  YUANTU_MAX_CONTEXT_TOKENS: {
    kind: 'number',
    range: [1, 100_000_000],
    description: '模型上下文窗口',
  },
  YUANTU_MAX_OUTPUT_TOKENS: { kind: 'number', range: [1, 10_000_000], description: '单次输出上限' },
  /**
   * Context windows of the endpoint's other models, as JSON `{"<model id>": {"contextWindow": n}}`.
   * Written by the desktop; the reader checks the shape.
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
  YUANTU_MAX_RUN_ROUNDS: {
    kind: 'number',
    range: [0, 100_000],
    description: '单次运行最多的模型轮次（0 = 不限；默认不限，失控由时长与 token 上限兜底）',
  },
  YUANTU_MAX_RUN_MS: {
    kind: 'number',
    range: [0, 86_400_000],
    description: '单次运行的墙钟上限（毫秒，0 = 不限；默认 2 小时）',
  },
  YUANTU_MAX_RUN_TOKENS: {
    kind: 'number',
    range: [0, 1_000_000_000],
    description: '单次运行累计消耗的模型 token 上限（输入 + 输出，0 = 不限；默认 2000 万）',
  },
  YUANTU_TOOL_TIMEOUT_MS: {
    kind: 'number',
    range: [0, 3_600_000],
    description: '单次工具调用的墙钟上限（毫秒，0 = 不设上限）',
  },
  YUANTU_WORKSPACE: { kind: 'string', description: '工作区目录' },
  YUANTU_SANDBOX: {
    kind: 'enum',
    values: ['host', 'native', 'windows', 'windows-account', 'seatbelt'],
    description:
      '命令沙箱模式（桌面：新会话从哪个模式开始——档位按会话选择，改动即时生效，不改写这个值；`windows` 为已移除的旧值，仅用于迁移识别）',
  },
  YUANTU_SANDBOX_HOOK: {
    kind: 'enum',
    values: ['host', 'native', 'windows', 'windows-account', 'seatbelt'],
    description:
      '钩子用的沙箱后端（默认继承当前调用的执行策略；`windows` 为已移除的旧值，仅用于迁移识别）',
  },
  YUANTU_SANDBOX_FILES: {
    kind: 'enum',
    values: ['read-only', 'workspace-write'],
    description: '工作区文件权限',
  },
  YUANTU_SANDBOX_NETWORK: {
    kind: 'enum',
    values: ['denied', 'unrestricted'],
    description: '命令网络权限；不支持所需隔离时拒绝执行',
  },
  // Internal: carries the Windows launcher's per-command payload, so the PowerShell script text
  // stays constant and is not re-scanned per command.
  YUANTU_SANDBOX_SPEC: { kind: 'string', description: '（内部）沙箱启动器的单次命令载荷' },
  YUANTU_SANDBOX_TEST_LAUNCH_PAUSE_MS: {
    kind: 'string',
    description: '（测试）沙箱启动器创建命令后、恢复前暂停的毫秒数',
  },
  YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE: {
    kind: 'enum',
    values: ['0', '1'],
    description: '（测试）仅在可丢弃 GitHub Actions runner 启用原生账户真实验收',
  },
  YUANTU_SANDBOX_ACL_SOURCE: {
    kind: 'string',
    description: '（内部）Host 快照的 ACL helper 载荷；不向客体传递',
  },
  YUANTU_PROGRAM_LAUNCH_DIR: {
    kind: 'string',
    description: '（内部）程序运行器离开工作区前记录的启动目录；由运行器覆盖',
  },
  YUANTU_PTY: {
    kind: 'string',
    description: '终端（terminal_* 工具）使用的 PTY 后端名，默认为内置的 node-pty',
  },
  YUANTU_ALLOW_PRIVATE_NETWORK: { kind: 'boolean', description: '是否允许访问私有网段' },
  YUANTU_FS_OBSERVATION: {
    kind: 'boolean',
    description: '改动文件前是否要求本运行已读过该文件（默认开启，关闭则不检查）',
  },
  YUANTU_PERMISSION_POLICY: { kind: 'string', description: '权限策略文件路径' },
  YUANTU_HOOKS_MODULE: { kind: 'string', description: '扩展钩子模块路径' },
  YUANTU_HOOK_BRIDGE: {
    kind: 'boolean',
    description: '是否加载工作区里声明的外部钩子（.claude/settings.json、.yuantu/hooks.json）',
  },
  YUANTU_TRUST_WORKSPACE_HOOKS: {
    kind: 'boolean',
    description: '强制信任所有工作区的外部钩子，跳过逐工作区的信任确认（仅用于自己掌控的环境）',
  },
  YUANTU_HOOK_TIMEOUT_MS: {
    kind: 'number',
    range: [1_000, 600_000],
    description: '单条外部钩子命令的超时（毫秒）',
  },
  YUANTU_SUBAGENT_MODELS: {
    kind: 'string',
    description: '额外的可委派模型 id（逗号分隔），供 list_subagent_models 列出',
  },
  YUANTU_SUMMARY_MODEL: {
    kind: 'string',
    description: '上下文压缩摘要使用的模型 id（同一端点；未设置则用主模型），其窗口不应小于主模型',
  },
  YUANTU_MCP_OAUTH_DIR: { kind: 'string', description: 'MCP OAuth 令牌目录' },
  YUANTU_DESKTOP_EXECUTABLE: {
    kind: 'string',
    description: '桌面程序（Electron）路径，由桌面设置；Windows 沙箱拒绝授权包含它的工作区',
  },
  YUANTU_STATE_DIR: {
    kind: 'string',
    description: '普通用户状态根目录（绝对路径，默认 ~/.yuantu）',
  },
  YUANTU_WORKTREE_DIR: {
    kind: 'string',
    description:
      '子代理隔离工作树的根目录（绝对路径；默认在用户数据目录下，位于仓库之外且不含受保护的路径片段）',
  },
  YUANTU_CREDENTIALS_FILE: {
    kind: 'string',
    description: '凭据文件路径（默认 ~/.yuantu/credentials.json；环境变量中的密钥优先于它）',
  },
  YUANTU_MEMORY_DIR: { kind: 'string', description: '用户级记忆目录' },
  /**
   * Whether runs use saved memories. `read` reads without writing; `off` disables memory entirely.
   */
  YUANTU_MEMORY: {
    kind: 'enum',
    values: ['on', 'read', 'off'],
    description:
      '记忆开关：on 读写（默认）；read 只注入和读取，不保存、不删除、不记使用时间；off 不注入、不提供记忆工具',
  },
  /**
   * The project whose workspace memories to use when working elsewhere. Set by the subprocess
   * sub-agent provider, whose scratch workspace has no `.yuantu`.
   */
  YUANTU_MEMORY_ROOT: {
    kind: 'string',
    description:
      '工作区记忆所属的项目目录（缺省为当前工作区；子进程子代理用它读取委派方项目的记忆）',
  },
  YUANTU_KNOWLEDGE_DB: { kind: 'string', description: '知识库数据库路径' },
  YUANTU_REPO_MAP: { kind: 'enum', values: ['on', 'off'], description: '是否注入结构大纲' },
  /**
   * The fast search backend's switch. `0` removes it; `1` or unset keeps it (it still needs a
   * verified asset).
   */
  YUANTU_SEARCH_RG: {
    kind: 'enum',
    values: ['0', '1'],
    description: '是否启用固定 ripgrep 快速搜索后端（0 关闭；缺省启用，但仍需已核验的固定资产）',
  },
  YUANTU_LSP_AFTER_EDIT: { kind: 'boolean', description: '编辑后是否附加诊断' },
  YUANTU_GIT_EXCLUDE: {
    kind: 'boolean',
    description: '是否把工作区 .yuantu 的运行期状态写入仓库的 .git/info/exclude（缺省开启）',
  },
  YUANTU_SUBAGENTS: { kind: 'boolean', description: '是否启用子代理委派' },
  YUANTU_TOOL_ALLOWLIST: {
    kind: 'string',
    description:
      '只提供这些工具（逗号分隔；不在列表里的工具既不展示也不能调用）。条目可以是工具名、`工具.action`（如 `lsp.hover`，只放开该操作）或旧工具名（只放开它原来的那个操作）。缺省不限制',
  },
  YUANTU_SUBAGENT_CONCURRENCY: { kind: 'number', range: [1, 16], description: '子代理并发上限' },
  YUANTU_WORKSPACE_RETENTION_DAYS: {
    kind: 'number',
    range: [1, 3650],
    description:
      '已移除的隔离工作区保留天数；超过后在 Host 启动时彻底清除（不可再恢复）。缺省不清除',
  },
  /**
   * Where a write-capable sub-agent executes. `auto` shares the directory for read-only children
   * and gives writers their own worktree. `shared` offers no isolation, and the interface must say
   * so.
   */
  YUANTU_SUBAGENT_WORKSPACE: {
    kind: 'enum',
    values: ['auto', 'shared', 'worktree'],
    description:
      '子代理执行目录：auto 自动隔离（默认），shared 沿用委派者目录（旧行为，不做隔离），worktree 连只读子代理也隔离',
  },
  YUANTU_SUBAGENT_TIMEOUT_MS: {
    kind: 'number',
    range: [0, 3_600_000],
    description:
      '子代理无进展（卡住）多久后停止（毫秒，0 = 不设看门狗；只要子代理还在产出就会重新计时，长任务不会被它切断）',
  },
  YUANTU_SEARCH_PROVIDER: { kind: 'string', description: '联网搜索提供方' },
  YUANTU_SEARCH_API_KEY: { kind: 'string', description: '联网搜索密钥' },
  YUANTU_SEARCH_BASE_URL: { kind: 'string', description: '联网搜索端点' },
  YUANTU_BUILTIN_SERVICES: { kind: 'boolean', description: '是否启用内置代码分析服务' },
  YUANTU_BUILTIN_SERVICES_URL: { kind: 'string', description: '内置分析服务地址（仅开发构建）' },
  YUANTU_PACKAGED: { kind: 'boolean', description: '是否为安装包运行' },
  YUANTU_WORKFLOWS: { kind: 'boolean', description: '是否启用持久任务调度' },
  /**
   * Whether the Host spends one small model call to name a session before its first reply. A switch
   * because it is an extra request to the endpoint; off leaves the first-message fallback title.
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
  /**
   * How many different sessions one Host may run at once; each session stays serial. Exclusive
   * operations (undo, plan execution, workspace import, compaction) wait for the whole Host. `1` is
   * fully serial.
   */
  YUANTU_HOST_MAX_RUNS: {
    kind: 'number',
    range: [1, 8],
    description: '同一 Host 可同时运行的不同会话数（默认 2；同一会话始终串行，1 为全局串行）',
  },
  // Test-only keys, listed because the check has to know every YUANTU_* name the project itself sets.
  YUANTU_NODE_PATH: { kind: 'string', description: '（测试）子进程使用的 node 路径' },
  YUANTU_TEST_WINDOWS_SHELL: {
    kind: 'enum',
    values: ['auto', 'cmd'],
    description:
      '（测试）Windows 上命令文本使用的 shell：auto 按 PowerShell 优先探测，cmd 固定用 cmd.exe（测试隔离环境默认设为 cmd，PowerShell 专项测试设为 auto）',
  },
  YUANTU_QA_DIR: { kind: 'string', description: '（测试）QA 产物目录' },
  YUANTU_QA_SCREENSHOT: { kind: 'string', description: '（测试）是否截图' },
  YUANTU_MCP_TEST_SECRET: { kind: 'string', description: '（测试）MCP 夹具密钥' },
} as const satisfies Record<string, EnvironmentSpec>;
export type EnvironmentKey = keyof typeof ENVIRONMENT;
/**
 * The one parser for `YUANTU_PROMPT_CACHE` and its vocabulary. Kept beside the protocol because
 * `auto` must also be resolved against the route.
 */
export function promptCacheMode(value: unknown): PromptCacheMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toLowerCase();
  /**
   * `Object.hasOwn`, so names like `constructor` or `__proto__` do not resolve through the
   * prototype.
   */
  const alias = Object.hasOwn(PROMPT_CACHE_ALIASES, text)
    ? (PROMPT_CACHE_ALIASES as Record<string, PromptCacheMode | undefined>)[text]
    : undefined;
  return alias ?? PROMPT_CACHE_MODES.find((mode) => mode === text);
}
/** What `auto` resolves to, and therefore what a connection that says nothing gets. */
export function defaultPromptCacheMode(protocol: string): PromptCacheMode {
  if (routeSupports(protocol, 'prompt-cache-blocks')) return 'blocks';
  if (routeSupports(protocol, 'prompt-cache-key')) return 'key-only';
  return 'off';
}
/**
 * The four model runtime limits, keyed by environment name with the matching settings field. The
 * range lives only in `ENVIRONMENT`; the desktop's env reader, settings contract and form bounds
 * read it through here.
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
 * How a person writes a value of this kind, as the parser enforces it. Shared by the CLI `env`
 * command, the README table and the desktop settings page. ASCII on purpose: a shape, not a
 * sentence.
 */
export function settingShape(spec: EnvironmentSpec): string {
  // A setting with its own vocabulary declares it.
  if (spec.shape) return spec.shape;
  if (spec.kind === 'enum') return spec.values!.join(' / ');
  if (spec.kind === 'number') return `${spec.range![0]}–${spec.range![1]}`;
  if (spec.kind === 'boolean') return '0 / 1';
  return 'string';
}
/**
 * Whether a setting's value is a credential, so it is only reported as present or absent. Shared by
 * the CLI `env` command and the desktop settings page. Name matching is deliberately broad; `_MS`
 * and `_TOKENS` are exempt because those are budgets and durations.
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
function closest(key: string): string | undefined {
  const ranked = Object.keys(ENVIRONMENT)
    .map((name) => ({ name, distance: editDistance(key, name) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(key.length / 4)) ? best.name : undefined;
}
function invalidValue(key: EnvironmentKey, value: string): string | undefined {
  const spec: EnvironmentSpec = ENVIRONMENT[key];
  // The custom rule knows this setting's vocabulary, so it goes first.
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
 * The typed value of one setting, or `undefined` when unset. The only reader, so rules cannot
 * drift. An empty value counts as unset.
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
 * Everything wrong with an environment: unknown keys and unusable values. Returned, not thrown, so
 * all are shown at once.
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
/** Limits for which `0` is a deliberate policy: none kept, never retried, or that budget turned off. */
const ZERO_ALLOWED = new Set([
  'toolResultKeepRecent',
  'maxModelRetries',
  'zeroByteRetries',
  'maxRunRounds',
  'maxRunMs',
  'maxRunTokens',
]);
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
    responseHeadersTimeoutMs:
      options.responseHeadersTimeoutMs ?? RUN_DEFAULTS.responseHeadersTimeoutMs,
    maxModelRetries: options.maxModelRetries ?? RUN_DEFAULTS.maxModelRetries,
    zeroByteRetries: options.zeroByteRetries ?? RUN_DEFAULTS.zeroByteRetries,
    investigationMs: options.investigationMs ?? RUN_DEFAULTS.investigationMs,
    questionTimeoutMs: options.questionTimeoutMs ?? RUN_DEFAULTS.questionTimeoutMs,
    maxRunRounds: options.maxRunRounds ?? RUN_DEFAULTS.maxRunRounds,
    maxRunMs: options.maxRunMs ?? RUN_DEFAULTS.maxRunMs,
    maxRunTokens: options.maxRunTokens ?? RUN_DEFAULTS.maxRunTokens,
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
   * Every limit must be at least one, except those in `ZERO_ALLOWED`, where `0` is a deliberate
   * policy.
   */
  for (const [name, value] of Object.entries(resolved)) {
    // An absent limit (e.g. `requestTimeoutMs`) is not a bad value.
    if (value === undefined) continue;
    const floor = ZERO_ALLOWED.has(name) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < floor) throw new Error(`Invalid ${name}`);
  }
  assertPrunePolicyFits({
    thresholdChars: resolved.toolResultPruneThresholdChars,
    headChars: resolved.toolResultPruneHeadChars,
    tailChars: resolved.toolResultPruneTailChars,
  });
  return resolved;
}
