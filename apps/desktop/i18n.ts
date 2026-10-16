import type { UiLanguage } from './ui-settings.ts';
import type { CarrierErrorCode } from '../../packages/carrier/errors.ts';

type Listener = () => void;
export type TranslationValues = Record<string, string | number>;
type Pair = [string, string];
const carrierMessages: Record<`carrier.${CarrierErrorCode}`, Pair> = {
  'carrier.workspaceMaintenanceUnsupported': [
    '当前 Host 不支持孤立工作区维护，请升级 Host。',
    'This Host does not support orphan workspace maintenance; upgrade the Host.',
  ],
  'carrier.hostExited': [
    'Agent Host 意外退出，请重新启动应用。',
    'Agent Host exited unexpectedly; restart the application.',
  ],
  'carrier.hostDisconnected': [
    '与 Agent Host 的连接已断开；请让启动它的载体重新连接。',
    'The Agent Host connection was lost; ask the carrier that started it to reconnect.',
  ],
  'carrier.policyUnsupported': [
    'Agent Host 不确认文件/网络执行策略（缺少 execution-policy-files-network-v1）；请升级 Agent Host 后重新选择该档位。',
    'Agent Host does not acknowledge file/network execution policy (missing execution-policy-files-network-v1); upgrade Agent Host and select the preset again.',
  ],
  'carrier.policyMismatch': [
    'Agent Host 未按请求确认执行策略（请求 {requested}，回执 {received}）；策略状态未知，在重新确认前不再执行。',
    'Agent Host did not confirm the requested execution policy (requested {requested}, received {received}); policy status is unknown and execution is blocked until it is confirmed again.',
  ],
  'carrier.hostRecoveryFailed': [
    'Agent Host 意外退出，自动重启失败；请重新启动应用。',
    'Agent Host exited unexpectedly and automatic restart failed; restart the application.',
  ],
  'carrier.hostRecovering': [
    'Agent Host 正在自动重启，请稍候。',
    'Agent Host is restarting automatically; please wait.',
  ],
  'carrier.hostNotReady': [
    'Agent Host 尚未就绪，请重新启动应用。',
    'Agent Host is not ready; restart the desktop',
  ],
  'carrier.policyUnconfirmed': [
    '执行策略尚未确认：上次沙箱选择未获 Agent Host 确认，请重新选择档位并确认后再运行。',
    'Execution policy is unconfirmed: Agent Host did not acknowledge the last sandbox selection. Select and confirm a preset before running again.',
  ],
  'carrier.modelNotConfigured': [
    '请打开“模型设置”，填写接口地址、模型 ID 和 API 密钥。',
    'Open Model settings and enter an endpoint, model ID and API key.',
  ],
  'carrier.draftPlanningFailed': [
    '草稿已保存，自动规划未完成；可编辑后执行。{message}',
    'The draft was saved, but automatic planning did not finish; edit it before execution. {message}',
  ],
  'carrier.sessionRequired': ['请先创建或打开会话。', 'Create or load a session first'],
  'carrier.subagentNotInSession': [
    '该子代理不属于当前会话。',
    'That sub-agent does not belong to this session',
  ],
  'carrier.sessionOperationBusy': [
    '会话操作正在进行，请稍候。',
    'Session operation is in progress',
  ],
  'carrier.runBusy': [
    '请等待当前运行或加载操作结束。',
    'Wait for the current run or loading operation to finish',
  ],
  'carrier.operationBusy': ['请等待当前操作结束。', 'Wait for the current operation to finish'],
  'carrier.taskNotFound': ['任务不存在。', 'Task not found'],
  'carrier.shellCommand': [
    '此命令应由应用界面处理。',
    'This command belongs to the carrier shell, not the carrier service',
  ],
};
const messages: Record<string, Pair> = {
  'orphans.title': ['保留的工作区', 'Retained workspaces'],
  'orphans.note': [
    '会话删除后保留的隔离目录和恢复记录。归档后可清理目录，已保存的源码可恢复。操作遵循当前会话选择的权限；没有当前会话时使用项目默认权限。',
    'Isolated directories and recovery records retained after session deletion. Archive before removing a directory; preserved source files can be restored. Operations follow the selected session permissions, or project defaults when no session is selected.',
  ],
  'orphans.refresh': ['刷新列表', 'Refresh list'],
  'orphans.loading': ['正在读取或处理工作区…', 'Loading or updating workspaces…'],
  'orphans.empty': ['当前项目没有保留的工作区。', 'No retained workspaces in this project.'],
  'orphans.results': ['{count} 份导出结果', '{count} exported results'],
  'orphans.confirmRemove': ['确认清理目录', 'Confirm removal'],
  'orphans.cancel': ['取消', 'Cancel'],
  'orphans.state.preparing': ['准备中', 'Preparing'],
  'orphans.state.ready': ['目录可用', 'Available'],
  'orphans.state.blocked': ['需要检查', 'Needs attention'],
  'orphans.state.archiving': ['归档中', 'Archiving'],
  'orphans.state.archived': ['已归档', 'Archived'],
  'orphans.state.removing': ['清理中', 'Removing'],
  'orphans.state.removed': ['目录已清理，可恢复', 'Directory removed; recovery available'],
  ...carrierMessages,
  'backup.title': ['数据备份', 'Data backups'],
  'backup.restore': ['恢复所选备份', 'Restore selected backup'],
  'backup.reconnectFailed': [
    '数据已恢复，但桌面重连失败，请重启应用。恢复前的数据副本保留在：{path}',
    'Data restored, but desktop reconnection failed. Restart the app. The previous data is preserved at: {path}',
  ],
  'backup.confirm': ['恢复 {date} 的数据库快照？', 'Restore the database snapshot from {date}?'],
  'backup.restoreDetail': [
    '当前工作区数据库会回到备份时的状态；当前数据库先保存为独立恢复副本。不会修改工作区文件。主对话不会自动续跑；已保存的定时/触发任务和目标唤醒仍按现有规则运行。',
    'The current workspace database returns to the snapshot state, after preserving the current database as a separate recovery copy. Workspace files are unaffected. The main conversation does not resume automatically; saved scheduled/event tasks and goal wake-ups continue under their existing rules.',
  ],
  'upgrade.menu': ['应用', 'Application'],
  'upgrade.check': ['检查本地升级包…', 'Check a local upgrade package…'],
  'upgrade.about': ['版本与渠道', 'Version and channel'],
  'upgrade.busy': [
    '请先完成或取消当前运行，并等待工作区/设置操作结束。',
    'Finish or cancel the current run and wait for workspace/settings operations to settle.',
  ],
  'upgrade.choose': [
    '选择升级安装包（当前 {version}，manual 渠道）',
    'Select an upgrade installer (current {version}, manual channel)',
  ],
  'upgrade.installer': ['Windows 安装包', 'Windows installer'],
  'upgrade.title': ['确认升级', 'Confirm upgrade'],
  'upgrade.confirm': ['从 {current} 升级到 {next}？', 'Upgrade from {current} to {next}?'],
  'upgrade.detail': [
    '仅从可信来源选择安装包。校验通过后会关闭终端与后台进程、备份当前工作区数据库并保留旧程序；不会自动续跑模型任务。请先关闭其他使用相同工作区的 Host/CLI。安装失败的日志和恢复副本保留在用户设置目录 upgrades 下。',
    'Select an installer from a trusted source. After verification, terminals and background processes close, the current workspace database is backed up and the old application is retained. Model runs do not resume automatically. Close other Hosts/CLIs using this workspace. Failure logs and recovery copies remain under upgrades in the user profile.',
  ],
  'upgrade.cancel': ['取消', 'Cancel'],
  'upgrade.install': ['备份并安装', 'Back up and install'],
  'upgrade.failed': ['升级未完成', 'Upgrade did not complete'],
  'upgrade.recovery': [
    '请检查用户设置目录 upgrades 下的 upgrade.json 和 upgrade.log。关闭应用及全部 Host/CLI 后，可使用同目录 maintenance-node.exe 与 upgrade-worker.cjs 执行 rollback <upgrade.json绝对路径> --offline。保留恢复副本及当前数据库，勿直接用旧版打开较新 schema。',
    'Inspect upgrade.json and upgrade.log under upgrades in the user profile. After closing the application and all Hosts/CLIs, use maintenance-node.exe and upgrade-worker.cjs in that directory to run rollback <absolute upgrade.json path> --offline. Retain recovery copies and the current database; do not open a newer schema with an old application.',
  ],
  'ui.addAttachment': ['添加图片或文件', 'Add images or files'],
  'general.languageZh': ['中文', '中文'],
  'general.languageEn': ['English', 'English'],
  'general.appearanceSystem': ['跟随系统', 'System'],
  'general.appearanceLight': ['浅色', 'Light'],
  'general.appearanceDark': ['深色', 'Dark'],
  'general.fontSmall': ['小', 'Small'],
  'general.fontMedium': ['标准', 'Standard'],
  'general.fontLarge': ['大', 'Large'],
  'general.saving': ['正在保存…', 'Saving...'],
  'general.saved': ['通用设置已保存。', 'General settings saved.'],
  'background.title': ['后台任务', 'Background tasks'],
  'background.runningCount': ['{count} 个后台任务运行中', '{count} background task(s) running'],
  'background.totalCount': ['{count} 个后台任务', '{count} background task(s)'],
  'background.commandLabel': ['命令', 'Command'],
  'background.exitCodeValue': ['退出码：{code}', 'exit code: {code}'],
  'background.clear': ['清理已结束', 'Clear finished'],
  'background.note': [
    '当前会话启动的后台命令。日志按增量读取，任务属于当前 Host，重启后不保留进程句柄。',
    'Background commands started by the current session. Logs are read incrementally; process handles are not retained after a Host restart.',
  ],
  'background.empty': ['当前没有后台任务。', 'No background tasks.'],
  'background.auto': ['完成后自动续跑', 'Continue on completion'],
  'background.budget': ['最多自动续跑次数（1～20）', 'Maximum automatic wakes (1–20)'],
  'background.seconds': ['每次最多秒数（1～300）', 'Seconds per wake (1–300)'],
  'background.pause': ['暂停', 'Pause'],
  'background.resume': ['恢复', 'Resume'],
  'background.reset': ['重置预算', 'Reset budget'],
  'background.used': [
    '已用 {used}/{max} 次 · 待处理 {pending}',
    'Used {used}/{max} · Pending {pending}',
  ],
  'background.stop': ['停止任务', 'Stop task'],
  'background.running': ['运行中', 'Running'],
  'background.starting': ['启动中', 'Starting'],
  'background.completed': ['已完成', 'Completed'],
  'background.cancelled': ['已取消', 'Cancelled'],
  'background.failed': ['失败', 'Failed'],
  'background.exitCode': ['退出码', 'Exit code'],
  'background.pid': ['进程号', 'PID'],
  'mcp.title': ['MCP 服务', 'MCP Services'],
  'mcp.description': [
    '连接外部工具，扩展当前工作区的能力。',
    'Connect external tools to extend this workspace.',
  ],
  'mcp.configured': ['已配置的服务', 'Configured services'],
  'mcp.add': ['添加服务', 'Add service'],
  'mcp.reload': ['重新加载', 'Reload'],
  'mcp.name': ['服务名称', 'Service name'],
  'mcp.nameNote': [
    '使用小写字母、数字和下划线，名称以字母开头。',
    'Use lowercase letters, numbers, and underscores; start with a letter.',
  ],
  'mcp.namePlaceholder': ['例如：project_tools', 'Example: project_tools'],
  'mcp.localProcess': ['本地进程（stdio）', 'Local process (stdio)'],
  'mcp.url': ['服务地址', 'Service URL'],
  'mcp.headers': ['请求头（JSON）', 'Request headers (JSON)'],
  'mcp.deletePrompt': [
    '删除此服务配置？下一轮对话将不再加载它。',
    'Delete this service configuration? It will no longer load in the next turn.',
  ],
  'mcp.confirmDelete': ['确认删除', 'Confirm delete'],
  'mcp.transport': ['连接方式', 'Transport'],
  'mcp.command': ['启动命令', 'Command'],
  'mcp.commandPlaceholder': ['node 或可执行文件路径', 'node or executable path'],
  'mcp.args': ['启动参数', 'Arguments'],
  'mcp.argsPlaceholder': ['每行一个参数', 'One argument per line'],
  'mcp.cwd': ['工作目录', 'Working directory'],
  'mcp.cwdPlaceholder': ['.（当前工作区）', '. (current workspace)'],
  'mcp.env': ['环境变量（JSON）', 'Environment variables (JSON)'],
  'mcp.enabled': ['启用此服务', 'Enable this service'],
  'mcp.note': [
    '密钥请使用环境变量引用；更改环境变量后需重启桌面。测试会连接服务或启动本地进程，仅发现工具，不调用工具。',
    'Reference secrets through environment variables; restart the desktop after changes. Tests connect or start a local process to discover tools without calling them.',
  ],
  'mcp.test': ['测试连接', 'Test connection'],
  'mcp.save': ['保存服务', 'Save service'],
  'mcp.delete': ['删除服务', 'Delete service'],
  'mcp.oauthSection': ['OAuth 授权', 'OAuth authorization'],
  'mcp.oauthEnabled': ['使用 OAuth 授权', 'Use OAuth authorization'],
  'mcp.oauthScopes': ['授权范围', 'Scopes'],
  'mcp.oauthScopesNote': [
    '多个范围用逗号或空格分隔；留空表示由服务端决定。',
    'Separate scopes with commas or spaces; leave empty to let the server decide.',
  ],
  'mcp.oauthScopesPlaceholder': ['留空表示由服务端决定', 'Empty lets the server decide'],
  'mcp.oauthClientId': ['客户端 ID', 'Client ID'],
  'mcp.oauthClientIdPlaceholder': [
    '留空则自动注册客户端',
    'Empty registers a client automatically',
  ],
  'mcp.oauthClientSecret': ['客户端密钥', 'Client secret'],
  'mcp.oauthClientSecretNote': [
    '仅接受 ${ENV_VAR} 形式的环境变量占位符，不会保存明文密钥。',
    'Only an ${ENV_VAR} environment placeholder is accepted; plaintext secrets are never saved.',
  ],
  'mcp.oauthClientSecretPlaceholder': ['${MCP_CLIENT_SECRET}', '${MCP_CLIENT_SECRET}'],
  'mcp.oauthClientName': ['客户端名称', 'Client name'],
  'mcp.oauthClientNamePlaceholder': ['YuanTu Agent', 'YuanTu Agent'],
  'mcp.oauthRedirectPort': ['回调端口', 'Callback port'],
  'mcp.oauthRedirectPortPlaceholder': ['自动选择', 'Choose automatically'],
  'mcp.authorize': ['授权', 'Authorize'],
  'mcp.cancelAuthorize': ['取消授权', 'Cancel authorization'],
  'mcp.revoke': ['撤销授权', 'Revoke authorization'],
  'mcp.oauthAuthorized': ['已授权', 'Authorized'],
  'mcp.oauthAuthorizedUntil': ['已授权，{time} 到期', 'Authorized, expires {time}'],
  'mcp.oauthNotAuthorized': ['尚未授权', 'Not authorized'],
  'mcp.oauthMissing': ['此服务未配置 OAuth 授权', 'OAuth is not configured for this service'],
  'mcp.oauthPending': [
    '请在浏览器中完成授权，然后返回此页面…',
    'Complete the authorization in your browser, then return here...',
  ],
  'mcp.oauthCancelled': ['已取消 MCP 授权。', 'MCP authorization cancelled.'],
  'mcp.oauthFailed': ['MCP 授权失败，请重试。', 'MCP authorization failed. Try again.'],
  'mcp.revoking': ['正在撤销授权…', 'Revoking authorization...'],
  'mcp.revoked': ['MCP 授权已撤销。', 'MCP authorization revoked.'],
  'general.title': ['通用设置', 'General'],
  'general.description': [
    '调整界面语言、外观和阅读字号。',
    'Adjust the interface language, appearance, and text size.',
  ],
  'general.language': ['语言', 'Language'],
  'general.languageNote': ['设置界面首选语言。', 'Set the preferred interface language.'],
  'general.appearance': ['外观', 'Appearance'],
  'general.appearanceNote': ['选择应用的明暗外观。', 'Choose the application appearance.'],
  'general.fontSize': ['字号', 'Text size'],
  'general.fontSizeNote': [
    '调整聊天内容和操作界面的基础字号。',
    'Adjust the base size of chat and interface text.',
  ],
  'general.save': ['保存设置', 'Save settings'],
  'sandboxSetup.title': ['Windows 增强隔离', 'Windows enhanced isolation'],
  'sandboxSetup.note': [
    '首次初始化需要 Windows 管理员确认。初始化后仍使用当前沙箱模式，增强模式需通过隔离验收后启用。',
    'First initialization requires Windows administrator approval. Your current sandbox mode stays active; enhanced isolation requires further verification before activation.',
  ],
  'sandboxSetup.initialize': ['管理员初始化', 'Initialize as administrator'],
  'sandboxSetup.refresh': ['检查状态', 'Check status'],
  'sandboxSetup.pending': [
    '正在处理，请完成 Windows 管理员确认…',
    'Working; complete the Windows administrator prompt…',
  ],
  'sandboxSetup.checking': ['正在检查初始化条件…', 'Checking initialization requirements…'],
  'sandboxSetup.ready': ['可以进行首次初始化。', 'Ready for first initialization.'],
  'sandboxSetup.installed': [
    '网络规则已初始化；增强沙箱尚未启用。',
    'Network rules initialized; enhanced sandbox is not activated.',
  ],
  'sandboxSetup.development': [
    '开发版本不提供管理员初始化，请使用受保护目录中的签名安装版本。',
    'Administrator initialization requires a signed release in a protected installation directory.',
  ],
  'sandboxSetup.runtime': [
    '无法验证当前安装包的运行时，请修复安装或使用可信的签名版本。',
    'The installed runtime could not be verified. Repair the installation or use a trusted signed release.',
  ],
  'sandboxSetup.release': [
    '安装位置或发布签名未通过检查，无法进行管理员初始化。',
    'Installation location or release signature verification failed; initialization is unavailable.',
  ],
  'sandboxSetup.failed': [
    '初始化未完成或状态检查失败。请确认管理员提示并重新检查状态。',
    'Initialization did not complete or its status could not be verified. Check the administrator prompt and refresh the status.',
  ],
  'settings.contextTokens': ['上下文窗口 Token', 'Context window tokens'],
  'settings.outputTokens': ['单次输出上限 Token', 'Maximum output tokens per request'],
  'settings.automaticBudget': ['自动（可手动指定）', 'Automatic (optional override)'],
  'settings.defaultLimit': ['默认（留空恢复）', 'Default (clear to reset)'],
  'settings.autoCompactTokens': ['自动压缩阈值 Token', 'Automatic compaction threshold tokens'],
  'settings.streamIdleTimeoutMs': ['流空闲超时（毫秒）', 'Stream idle timeout (milliseconds)'],
  'ui.loadOlderHistory': [
    '加载更早的消息（还有 {count} 条）',
    'Load earlier messages ({count} remaining)',
  ],
  'settings.description': [
    '管理模型连接，为每次对话选择合适的模型。',
    'Manage model connections and choose a model for each conversation.',
  ],
  'settings.noModel': ['尚无模型', 'No models'],
  'settings.connectionConfigured': ['已保存密钥；留空则沿用', 'Saved key; leave blank to keep'],
  'settings.currentConfig': ['当前配置：{source}', 'Current configuration: {source}'],
  'settings.savedLocally': ['本机保存', 'Saved locally'],
  'settings.fromEnvironment': ['环境变量', 'Environment'],
  'settings.notConfigured': ['未配置', 'Not configured'],
  'settings.selectHint': ['正在切换模型…', 'Switching model...'],
  'settings.endpointName': ['名称', 'Name'],
  'settings.endpointNamePlaceholder': ['例如：常用接口', 'e.g. Primary endpoint'],
  'settings.endpointGroup': ['已保存的接口', 'Saved endpoints'],
  'settings.newEndpoint': ['新增接口', 'New endpoint'],
  'settings.addModel': ['添加模型', 'Add model'],
  'settings.displayName': ['显示名称', 'Display name'],
  'settings.expandModel': ['展开模型参数', 'Expand model settings'],
  'settings.collapseModel': ['收起模型参数', 'Collapse model settings'],
  'settings.removeModel': ['删除模型', 'Remove model'],
  'settings.cancel': ['取消', 'Cancel'],
  'settings.modelList': ['模型列表', 'Models'],
  'settings.newEndpointOption': ['新接口（未保存）', 'New endpoint (unsaved)'],
  'settings.atLeastOne': ['至少保留一个模型。', 'Keep at least one model.'],
  'settings.duplicateModel': [
    '同一接口下的模型 ID 不可重复。',
    'Model IDs must be unique for an endpoint.',
  ],
  'settings.saveGroup': ['保存', 'Save'],
  'settings.savedConnections': ['已保存的连接', 'Saved connections'],
  'settings.newConnection': ['新增连接', 'New connection'],
  'settings.applyDefault': ['应用并设为默认', 'Apply and set default'],
  'settings.connectionName': ['连接名称', 'Connection name'],
  'settings.namePlaceholder': ['例如：日常编码', 'Example: Daily coding'],
  'settings.protocol': ['接口协议', 'API protocol'],
  'settings.protocolNote': [
    '支持官方接口与兼容网关',
    'Supports official APIs and compatible gateways',
  ],
  'settings.url': ['接口地址', 'API endpoint'],
  'settings.urlNote': ['填写根地址或以 /v1 结尾的地址。', 'Enter a root URL or one ending in /v1.'],
  'settings.modelId': ['模型 ID', 'Model ID'],
  'settings.modelNote': ['填写接口支持的模型 ID', 'Enter a model ID supported by the endpoint'],
  'settings.apiKey': ['API 密钥', 'API key'],
  'settings.apiKeyNote': [
    '密钥使用系统加密存储。更换接口地址时需重新输入密钥。',
    'The key is stored with system encryption. Enter it again when changing the endpoint.',
  ],
  'settings.testNote': [
    '测试连接会发送一条简短请求，消耗少量 Token。',
    'Connection tests send a short request and use a small number of tokens.',
  ],
  'settings.test': ['测试连接', 'Test connection'],
  'settings.discover': ['从端点读取规格', 'Read limits from endpoint'],
  'settings.discovering': ['正在读取端点目录…', 'Reading the endpoint catalogue...'],
  'settings.discoverFilled': [
    '已填入 {models} 的窗口与单次输出上限。',
    'Filled the window and output cap for {models}.',
  ],
  'settings.discoverNoWindow': [
    '端点没有声明 {models} 的窗口；留空将自动采用应用预算，也可按提供方规格填写。',
    'The endpoint declared no window for {models}; leave blank for the automatic app budget or enter the provider limit.',
  ],
  'settings.discoverMissing': [
    '端点目录里没有 {models}（可用：{list}）。',
    'The catalogue has no {models} (available: {list}).',
  ],
  'settings.discoverEmpty': ['端点没有返回任何模型。', 'The endpoint returned no models.'],
  'settings.discoverError': [
    '无法读取端点目录，请检查接口地址、协议与密钥。',
    'Could not read the endpoint catalogue; check the URL, protocol and key.',
  ],
  'settings.saveApply': ['保存并应用', 'Save and apply'],
  'settings.connectionError': [
    '无法读取模型配置，请重新启动桌面。',
    'Unable to read model settings. Restart the desktop.',
  ],
  'ui.promptPlaceholder': [
    '发消息或描述任务，让想法逐步落地…',
    'Send a message or describe a task...',
  ],
  'ui.newSession': ['新建会话', 'New session'],
  'ui.workspace': ['工作区', 'Workspace'],
  'ui.changeFolder': ['更换目录', 'Change folder'],
  'ui.recentSessions': ['最近会话', 'Recent sessions'],
  'ui.clearSessionSearch': ['清除并关闭搜索', 'Clear and close search'],
  'ui.searchSessions': ['搜索会话', 'Search sessions'],
  'ui.searchSessionsOrMessages': ['搜索会话或消息', 'Search sessions or messages'],
  'ui.closeSearch': ['关闭搜索', 'Close search'],
  'ui.noMatchingSessions': ['无匹配会话', 'No matching sessions'],
  'ui.searchNameOnly': [
    '内容搜索不可用，仅显示名称匹配。',
    'Content search is unavailable; matching session names only.',
  ],
  'ui.sessionList': ['会话列表', 'Session list'],
  'ui.projectCapabilities': ['项目能力', 'Project capabilities'],
  'ui.refreshCapabilities': ['刷新项目能力', 'Refresh capabilities'],
  'ui.settings': ['设置', 'Settings'],
  'ui.projectSession': ['项目会话', 'Project session'],
  'ui.chat': ['对话', 'Chat'],
  'ui.conversation': ['对话内容', 'Conversation'],
  'ui.taskDescription': ['任务描述', 'Task description'],
  'ui.addImage': ['添加图片', 'Add images'],
  'ui.queueMode': ['追加方式', 'Queue mode'],
  'ui.runAfterCompletion': ['完成后执行', 'Run after completion'],
  'ui.steerTask': ['调整当前任务', 'Steer current task'],
  // Missing until now, so the queue row printed the raw key `ui.followUp` in both languages: the composer's
  // enqueue control offers "steer" and "follow-up", and only the first had a translation.
  'ui.followUp': ['后续任务', 'Follow-up task'],
  'ui.toolCardLines': ['第 {start}–{end} 行 / 共 {total} 行', 'lines {start}–{end} of {total}'],
  'ui.toolCardEmptyFile': ['空文件', 'empty file'],
  /**
   * A read whose window starts past the end of the file.
   *
   * Its own string rather than `ui.toolCardEmptyFile`: the file is not empty — the requested range is, and the
   * total is still the fact that says so. Reusing the empty-file text here would take a request that found
   * nothing and turn it into a claim about the file.
   */
  'ui.toolCardEmptyRange': [
    '此范围没有内容（共 {total} 行）',
    'no content in this range ({total} lines)',
  ],
  'ui.toolCardTruncated': ['已截断', 'truncated'],
  'ui.toolCardLiteral': ['字面匹配', 'literal'],
  'ui.toolCardRegex': ['正则匹配', 'regex'],
  'ui.toolCardMatches': ['{count} 处匹配', '{count} matches'],
  'ui.toolCardMatchRows': [
    '仅画前 {shown} 处，共 {count} 处',
    'drawing the first {shown} of {count}',
  ],
  'ui.toolCardLimited': ['结果被截断，不是全部匹配', 'truncated: these are not all the matches'],
  'ui.toolCardNoMatches': ['没有匹配', 'no matches'],
  /**
   * Three statements about a search that are not the same statement.
   *
   * `coverageUnknown` is what a result written before coverage existed says: the scan happened, and whether it
   * reached the end of the workspace is simply not recorded. `incomplete` is a scan that stopped early and knows
   * why. Neither may be rendered as the other, and neither may be rendered as "no matches" — which is why the
   * card shows one of these instead of staying silent.
   */
  'ui.toolCardCoverageUnknown': ['扫描范围未记录', 'scan coverage not recorded'],
  'ui.toolCardIncomplete': ['扫描不完整：{reasons}', 'incomplete scan: {reasons}'],
  'ui.toolCardOutputTruncated': [
    '返回结果已按输出预算截断',
    'the returned matches were cut to the output budget',
  ],
  'ui.toolCardExit': ['退出码 {code}', 'exit {code}'],
  'ui.toolCardSignal': ['被 {signal} 终止', 'killed by {signal}'],
  'ui.toolCardUnknownExit': ['退出码未知', 'exit code unknown'],
  'ui.toolCardTimeout': ['超时', 'timed out'],
  'ui.toolCardStderr': ['标准错误', 'stderr'],
  'ui.toolCardNoOutput': ['没有输出', 'no output'],
  'ui.toolCardRaw': ['工具结果原文', 'Raw tool result'],
  'ui.model': ['模型', 'Model'],
  'ui.switchModel': ['切换模型', 'Switch model'],
  'ui.loading': ['正在加载…', 'Loading...'],
  'ui.stop': ['停止', 'Stop'],
  'ui.send': ['发送', 'Send'],
  'ui.queue': ['追加', 'Queue'],
  'ui.clearQueue': ['清空待执行消息', 'Clear queued messages'],
  'ui.sessionName': ['会话名称', 'Session name'],
  'ui.cancel': ['取消', 'Cancel'],
  'ui.confirm': ['确认', 'Confirm'],
  'ui.backToChat': ['返回对话', 'Back to chat'],
  'ui.general': ['通用设置', 'General'],
  'ui.models': ['模型设置', 'Models'],
  'ui.commands': ['指令', 'Commands'],
  'ui.commandAndSkills': ['指令和技能', 'Commands and skills'],
  'ui.skills': ['技能', 'Skills'],
  'ui.permissions': ['权限设置', 'Permissions'],
  'ui.refreshSkills': ['刷新技能', 'Refresh skills'],
  'ui.compactContext': ['压缩上下文', 'Compact context'],
  'ui.exportSession': ['导出会话', 'Export session'],
  'ui.createGoal': ['创建目标', 'Create goal'],
  'ui.createPlan': ['制定计划', 'Create plan'],
  'command.modelDescription': [
    '打开模型设置并切换当前连接',
    'Open model settings and switch the current connection',
  ],
  'command.permissionsDescription': ['打开权限模式设置', 'Open permission mode settings'],
  'command.newSessionDescription': ['创建并切换到新的会话', 'Create and switch to a new session'],
  'command.stopDescription': ['停止当前正在执行的任务', 'Stop the current running task'],
  'command.refreshSkillsDescription': [
    '重新读取项目技能和指令',
    'Reload project skills and instructions',
  ],
  'command.compactDescription': [
    '用当前模型整理会话上下文，下一轮生效',
    'Summarize this conversation with the current model for the next turn',
  ],
  'command.exportDescription': [
    '导出当前会话为 Markdown 文件',
    'Export this conversation as a Markdown file',
  ],
  'command.goalDescription': ['创建一个可持续跟踪的目标', 'Create a goal you can track over time'],
  'command.planDescription': [
    '只读探索后给出计划，人工批准才执行',
    'Read-only exploration, then a plan that needs human approval to run',
  ],
  'ui.copy': ['复制代码', 'Copy code'],
  'ui.copied': ['已复制', 'Copied'],
  'ui.copyFailed': ['复制失败', 'Copy failed'],
  'ui.openLinkFailed': ['打开链接失败', 'Failed to open link'],
  'ui.image': ['图片', 'Image'],
  'ui.imageNotLoaded': ['未加载', 'not loaded'],
  'ui.removeImage': ['移除 {name}', 'Remove {name}'],
  'ui.sendTimeUnavailable': ['这条消息未记录发送时间', 'Send time unavailable for this message'],
  'ui.copyMessage': ['复制问题', 'Copy message'],
  'ui.operationFailed': ['操作未完成', 'Operation failed'],
  'ui.toolResult': ['工具结果', 'Tool result'],
  'ui.runningTool': ['正在执行 {name}', 'Running {name}'],
  'ui.sessionChanges': [
    '会话改动 · {count} 次文件操作',
    'Session changes · {count} file operations',
  ],
  'ui.editedFiles': ['已编辑 {count} 个文件', 'Edited {count} files'],
  'ui.previewChanges': ['在侧边栏预览', 'Preview in sidebar'],
  'ui.allChangedFiles': ['全部 {count} 个文件', 'All {count} files'],
  'ui.collapseChangedFiles': ['收起文件列表', 'Collapse file list'],
  'ui.legacyChange': [
    '这条记录没有恢复快照，仅可查看差异。',
    'This record has no recovery snapshot; only the diff is available.',
  ],
  'ui.projectResources': [
    '项目规则 {instructions} · 技能 {skills} · 扩展 {extensions}',
    'Project rules {instructions} · Skills {skills} · Extensions {extensions}',
  ],
  'ui.queueItem': ['{mode}：{prompt}', '{mode}: {prompt}'],
  'ui.approvalRequired': ['需要你的确认', 'Approval required'],
  'ui.externalService': ['访问外部服务', 'Access external service'],
  'ui.runCommand': ['执行命令', 'Run command'],
  'ui.modifyFiles': ['修改文件', 'Modify files'],
  'ui.fullDetails': ['完整操作参数', 'Full operation details'],
  'ui.allowOnce': ['允许一次', 'Allow once'],
  'ui.deny': ['拒绝', 'Deny'],
  'ui.undoChange': ['撤销此修改', 'Undo this change'],
  'plan.title': ['计划', 'Plan'],
  'plan.status.planning': ['正在制定计划', 'Planning in progress'],
  'plan.status.proposed': ['等待批准', 'Awaiting approval'],
  'plan.status.approved': ['已批准', 'Approved'],
  'plan.status.rejected': ['已拒绝', 'Rejected'],
  'plan.status.abandoned': ['已废弃', 'Abandoned'],
  'plan.approve': ['批准计划', 'Approve plan'],
  'plan.reject': ['拒绝', 'Reject'],
  'plan.execute': ['按计划执行', 'Execute plan'],
  'plan.approvedHint': ['已批准，可开始执行。', 'Approved; ready to execute.'],
  'plan.gateHint': [
    '批准前不会执行任何写入；执行时代理会再次校验计划内容未变。',
    'Nothing is written before approval, and the change check runs again when execution starts.',
  ],
  'plan.rejectedHint': ['计划已被拒绝，可重新制定。', 'The plan was rejected; you can plan again.'],
  'plan.discard': ['放弃这份计划', 'Discard this plan'],
  /**
   * The one action a *planning* row needs, now that such a row keeps the session in plan mode.
   *
   * A session whose plan is still being written continues planning (that is what the row means), so without a way
   * to throw the plan away a person who changed their mind would be left in read-only with nothing to click.
   */
  'plan.discardHint': [
    '这次会话仍在计划模式：继续提问会继续制定计划。若不想再计划，先放弃这份计划。',
    'This session is still planning: your next message continues the plan. Discard the plan to leave plan mode.',
  ],
  'plan.abandonedHint': [
    '制定这份计划的运行已中断，这份计划不会再完成；可以重新发起一次计划。',
    'The run that was preparing this plan was interrupted, so it will not finish. You can plan again.',
  ],
  'subagent.title': ['子代理', 'Sub-agents'],
  'subagent.cardTitle': ['子代理 {index}/{total} · {role}', 'Sub-agent {index}/{total} · {role}'],
  'subagent.role.explore': ['只读调查', 'read-only research'],
  'subagent.role.general': ['可写入', 'write-capable'],
  'subagent.status.running': ['执行中', 'Running'],
  'subagent.status.completed': ['已完成', 'Completed'],
  'subagent.status.failed': ['失败', 'Failed'],
  'subagent.status.cancelled': ['已取消', 'Cancelled'],
  'subagent.status.limited': ['受限', 'Limited'],
  'subagent.status.needs_review': ['待复核', 'Needs review'],
  'subagent.status.interrupted': ['中断，待复核', 'Interrupted; review required'],
  'subagent.status.skipped': ['未启动', 'Not started'],
  'subagent.runningTool': ['正在执行 {tool}', 'Running {tool}'],
  'subagent.runningToolWithArgs': ['正在执行 {tool} · {args}', 'Running {tool} · {args}'],
  'subagent.meta': ['{rounds} 轮 · {tools} 次工具调用', '{rounds} rounds · {tools} tool calls'],
  'subagent.tokens': ['{value} tok', '{value} tok'],
  /**
   * A child's work time. Seconds are two-digit from a minute up — `21分07秒` reads as a duration where
   * `21分7秒` reads as two numbers — and the tiers stop at days, because this measures how long a child
   * *worked*: a child that has been working for a month is a broken run, not a reading.
   */
  'subagent.duration.seconds': ['{seconds}秒', '{seconds}s'],
  'subagent.duration.minutes': ['{minutes}分{seconds}秒', '{minutes}m {seconds}s'],
  'subagent.duration.hours': [
    '{hours}小时{minutes}分{seconds}秒',
    '{hours}h {minutes}m {seconds}s',
  ],
  'subagent.duration.days': ['{days}天', '{days}d'],
  'subagent.duration.daysHours': ['{days}天{hours}小时', '{days}d {hours}h'],
  'subagent.duration.exact': ['总活跃耗时：{duration}', 'Total active time: {duration}'],
  'subagent.catalog.one': ['{count} 个子代理', '{count} subagent'],
  'subagent.catalog.other': ['{count} 个子代理', '{count} subagents'],
  'subagent.catalog.running.one': ['{count} 个子代理，正在运行', '{count} subagent running'],
  'subagent.catalog.running.other': ['{count} 个子代理，正在运行', '{count} subagents running'],
  'subagent.viewTranscript': ['查看记录', 'View transcript'],
  'subagent.transcriptNote': [
    '只读：这是该子代理自己会话里的完整记录。',
    "Read-only: this is the full transcript of the sub-agent's own session.",
  ],
  'subagent.transcriptTruncated': [
    '过程记录较长，此处展示最近记录。最终结果单独展示。',
    'Recent process records are shown here. The final result is displayed separately.',
  ],
  'subagent.workspace.dependenciesMissing': [
    '隔离副本尚未安装项目依赖；需要依赖的检查须先审批安装。',
    'Project dependencies are not installed in this isolated copy; approve a local install before checks that need them.',
  ],
  'subagent.process': ['执行过程', 'Execution history'],
  'subagent.workspace.action.archive': ['归档工作区', 'Archive workspace'],
  'subagent.workspace.action.remove': ['清理已归档目录', 'Remove archived directory'],
  'subagent.workspace.action.restore': ['恢复工作区', 'Restore workspace'],
  'subagent.workspace.removeConfirm': [
    '清理这个已归档的子代理目录？源码将保存到可恢复快照；未能保存的文件会阻止清理。',
    'Remove this archived sub-agent directory? Source files will be saved in a recoverable snapshot; files that cannot be preserved prevent removal.',
  ],
  'subagent.processCount': ['执行过程 · {count} 条记录', 'Execution history · {count} records'],
  'subagent.processRecentCount': [
    '执行过程 · 最近 {count} 条记录',
    'Execution history · latest {count} records',
  ],
  'subagent.finalResult': ['最终结果', 'Final result'],
  'subagent.liveProgress': ['当前进展', 'Current progress'],
  'subagent.finalPending': [
    '子代理仍在运行，完成后显示最终结果。',
    'The sub-agent is running. Its final result will appear when it finishes.',
  ],
  'subagent.finalEmpty': [
    '该子代理没有生成最终结果。',
    'This sub-agent did not produce a final result.',
  ],
  'subagent.transcriptEmpty': ['该子代理还没有任何记录。', 'The sub-agent recorded no messages.'],
  'subagent.transcriptLoading': ['正在载入记录…', 'Loading the record…'],
  'subagent.back': ['返回会话：{title}', 'Back to the conversation: {title}'],
  'subagent.findings': ['结论与依据', 'Findings and evidence'],
  'subagent.evidence': ['依据', 'Evidence'],
  'subagent.unverified': ['未核实', 'Unverified'],
  'subagent.blockers': ['阻塞', 'Blockers'],
  'subagent.message.user': ['任务', 'Task'],
  // Not '子代理': the zh→en index used by the DOM walker is last-wins for duplicate source strings,
  // so reusing the panel title's text would silently rename the panel itself.
  'subagent.message.assistant': ['子代理回复', 'Sub-agent reply'],
  'subagent.message.tool': ['工具', 'Tool'],
  'subagent.attribution': ['子代理：{objective}', 'Sub-agent: {objective}'],
  /**
   * Where a sub-agent worked, and what happened to its work.
   *
   * The two "where" labels are not translations of each other and must not be collapsed: one promises that the
   * child's changes are somewhere else and have to be imported, the other says there is no separation at all. A
   * person reading "isolated" over a shared child would look in the wrong pane for its work.
   */
  'subagent.workspace.isolated': ['独立工作区：{path}', 'Isolated workspace: {path}'],
  'subagent.workspace.shared': [
    '共享工作区：与本次会话同一目录，改动直接出现在变更列表里，不做隔离',
    'Shared workspace: the same directory as this session, so its changes appear directly in the change list — not isolated',
  ],
  'subagent.workspace.problem': ['工作区不可用：{reason}', 'Workspace unusable: {reason}'],
  'subagent.workspace.result.ready': [
    '成果待合入（{count} 个路径）',
    'Result awaiting import ({count} path(s))',
  ],
  'subagent.workspace.result.unsupported': [
    '成果无法自动合入（{count} 个路径），请在子代理目录中人工处理',
    'Result cannot be imported automatically ({count} path(s)); review the sub-agent’s directory instead',
  ],
  'subagent.workspace.result.applying': ['正在合入', 'Import in progress'],
  'subagent.workspace.result.applied': ['已合入', 'Imported'],
  'subagent.workspace.result.conflict': [
    '合入冲突：目标文件已被修改，未写入任何文件',
    'Import conflict: the target files changed, so nothing was written',
  ],
  'subagent.workspace.result.superseded': [
    '已被该子代理后续回合取代',
    'Superseded by a later turn of this sub-agent',
  ],
  'ui.resumeUndo': ['继续完成恢复', 'Resume the interrupted undo'],
  'ui.undoInterrupted': [
    '上次撤销被中断（应用被关闭或进程意外结束），文件可能只恢复了一部分；可继续完成恢复。',
    'The previous undo was interrupted, so some files may not be restored yet. Resume it to finish.',
  ],
  'ui.undoNewFile': ['确认删除此新建文件', 'Confirm deleting this new file'],
  'ui.undoContent': ['确认恢复修改前内容', 'Confirm restoring previous content'],
  'ui.undone': ['已撤销', 'Undone'],
  'ui.restoreContent': ['可恢复修改前的文件内容', 'The previous file content can be restored'],
  'ui.uncertainResult': [
    '操作结果不确定，请检查文件后再处理。',
    'The operation result is uncertain. Check the file before continuing.',
  ],
  'ui.noSnapshot': [
    '这条记录没有本会话的恢复快照，仅可查看差异。',
    'This record has no recovery snapshot for this session; only the diff is available.',
  ],
  'ui.modelReasoning': ['正在推理…', 'Reasoning...'],
  'ui.modelToolCall': ['正在生成工具调用…', 'Generating tool call...'],
  'ui.thinking': ['思考中…', 'Thinking...'],
  /**
   * The folded reasoning block. It is a label, not a summary: the runtime never writes prose about a thought,
   * because any sentence it invented would be its own text sitting next to the model's.
   */
  'ui.reasoning': ['思考过程', 'Reasoning'],
  'ui.reasoningTail': [
    '共 {count} 个字符，只显示末尾 {shown} 个字符。',
    '{count} characters in all; showing the last {shown}.',
  ],
  'ui.liveTail': [
    '已生成 {count} 个字符，暂时显示末尾；完成后显示全文。',
    'Generated {count} characters. Showing the latest part until the full reply is ready.',
  ],
  'ui.interruptedReply': ['回复中断，已保留部分内容', 'Reply interrupted; partial content saved'],
  'ui.runPaused': ['提问已暂停', 'Paused'],
  /**
   * Shown after the app restarted a Host that died on its own. It has to say two things and no more: that the
   * window is usable again, and that the run which was in flight did not continue — the second is the part a
   * silent recovery would hide, and a user still waiting for a reply deserves to know why it never arrives.
   */
  'ui.hostRecovered': [
    'Agent Host（进程 {pid}）意外退出，已自动重启并从会话日志重建（第 {attempts} 次尝试）。中断的那一轮不会继续：它的未完成调用已记为"结果未知"。',
    'The Agent Host (pid {pid}) exited. It was restarted and the session was rebuilt from its log (attempt {attempts}). The interrupted run did not continue; its unfinished calls are recorded as "outcome unknown".',
  ],
  'ui.stopping': ['正在停止…', 'Stopping...'],
  'ui.sessionShort': ['会话 {id}', 'Session {id}'],
  'ui.commandNeedsDescription': ['/{name} 需要描述内容。', '/{name} requires a description.'],
  'ui.maxImages': ['每条消息最多附加 4 张图片', 'Each message can include at most 4 images'],
  'ui.maxImageTotal': ['图片合计不能超过 10MB', 'Images must total no more than 10 MB'],
  'ui.maxImage': ['单张图片不能超过 5MB', 'Each image must be no larger than 5 MB'],
  'ui.imageReadFailed': ['图片读取失败', 'Failed to read image'],
  'ui.connectionInterrupted': [
    '桌面连接中断，请重新启动后检查会话记录。',
    'Desktop connection interrupted. Restart it and check the session history.',
  ],
  'session.actions': ['会话操作', 'Session actions'],
  'session.rename': ['重命名', 'Rename'],
  'session.delete': ['删除', 'Delete'],
  'session.renameTitle': ['重命名会话', 'Rename session'],
  'session.deleteTitle': ['删除会话？', 'Delete session?'],
  'session.renameDescription': [
    '使用简短的名称，方便以后查找。',
    'Use a short name that is easy to find later.',
  ],
  'session.deleteDescription': [
    '将删除“{title}”的消息、图片和文件撤销记录，无法恢复。项目文件及其他会话会保留。',
    'Messages, images, and file undo records for “{title}” will be deleted permanently. Project files and other sessions will be kept.',
  ],
  'session.saveName': ['保存名称', 'Save name'],
  'session.confirmDelete': ['确认删除', 'Confirm delete'],
  'session.enterName': ['请输入会话名称。', 'Enter a session name.'],
  'session.operationFailed': [
    '操作未完成，请关闭此窗口查看错误并重试。',
    'Operation failed. Close this dialog, review the error, and try again.',
  ],
  'diff.create': ['新建', 'Create'],
  'diff.edit': ['修改', 'Edit'],
  'diff.delete': ['删除', 'Delete'],
  'diff.move': ['移动', 'Move'],
  'diff.batch': ['批量修改', 'Batch edit'],
  'diff.incomplete': [
    'Diff 预览不完整，请展开完整操作参数核对。',
    'The diff preview is incomplete. Expand the full operation details to verify it.',
  ],
  'settings.currentDefault': ['当前默认', 'Current default'],
  'common.done': ['操作完成。', 'Done.'],
  'ui.pendingAttachments': ['待发送附件', 'Pending attachments'],
  'ui.noModelConfigured': [
    '尚未配置模型。点击左下角“设置”，进入“模型设置”，填写接口和密钥即可开始聊天。已有会话仍可查看。',
    'No model is configured yet. Open Settings in the lower left, choose Model settings, and enter an endpoint and key to start chatting. Existing sessions stay readable.',
  ],
  'settings.addModelConnection': ['在设置中添加模型连接', 'Add a model connection in settings'],
  'mcp.empty': ['尚未配置 MCP 服务', 'No MCP services configured'],
  'mcp.addNew': ['添加新服务…', 'Add a new service...'],
  'ui.appName': ['源图 AI', 'Yuantu AI'],
  'ui.pendingApprovals': ['待审批操作', 'Pending approvals'],
  'ui.questionLabel': ['需要你的回答', 'Your answer is needed'],
  'ui.questionFreeText': ['输入你的答案', 'Type your answer'],
  'ui.questionSubmit': ['提交', 'Submit'],
  'ui.questionSkip': ['跳过本题', 'Skip this question'],
  'ui.questionRecommended': ['推荐', 'Recommended'],
  'ui.questionCollapse': ['收起', 'Collapse'],
  'ui.questionClose': ['关闭', 'Close'],
  'ui.questionPrevious': ['上一题', 'Previous question'],
  'ui.questionNext': ['下一题', 'Next question'],
  'ui.todosTitle': ['任务', 'Tasks'],
  'ui.todosSummary': [
    '{completed} 已完成 · {inProgress} 进行中 · {pending} 待处理',
    '{completed} done · {inProgress} in progress · {pending} pending',
  ],
  'ui.jumpToLatest': ['回到最新消息', 'Jump to latest message'],
  'ui.toolCall': ['工具调用', 'Tool call'],
  'ui.search': ['搜索', 'Search'],
  'ui.read': ['读取', 'Read'],
  'ui.edit': ['编辑', 'Edit'],
  'ui.todosCount': [
    '{total} 项：{completed} 已完成，{inProgress} 进行中，{pending} 待办',
    '{total} item(s): {completed} done, {inProgress} in progress, {pending} pending',
  ],
  'ui.todoStatus.pending': ['待办', 'Pending'],
  'ui.todoStatus.in_progress': ['进行中', 'In progress'],
  'ui.todoStatus.completed': ['已完成', 'Done'],
  'ui.goalTitle': ['会话目标', 'Session goal'],
  'ui.goalStatus.active': ['进行中', 'Active'],
  'ui.goalStatus.paused': ['已暂停', 'Paused'],
  'ui.goalStatus.blocked': ['受阻', 'Blocked'],
  'ui.goalStatus.completed': ['已完成', 'Completed'],
  'ui.goalRounds': ['已用 {spent}/{max} 轮', '{spent} of {max} round(s) spent'],
  'ui.goalBlockedReason': ['受阻原因：{reason}', 'Blocked because: {reason}'],
  'ui.goalNotice': [
    '目标跨轮次保留：只要它还处于活动状态，运行结束后会自动开始下一轮；轮数用完或你让它停下为止。',
    'The goal survives the run: while it stays active, the runtime starts the next round on its own until the budget or the user stops it.',
  ],
  'ui.deliverablesTitle': ['交付物', 'Deliverables'],
  /**
   * The completion contract, in the words a person decides with.
   *
   * Five states and not one: "the run ended", "the acceptance passed", "nothing has verified this", "a person has
   * to look", and "this run is not allowed to keep trying". Collapsing any two of them is how the old UI could
   * show "done" for work nobody had checked — which is the failure the whole contract exists to remove. Nothing
   * here shows a hash, an attempt id or an effect id: a reader deciding whether to trust the work is not served by
   * the runtime's bookkeeping.
   */
  'ui.completionTitle': ['验收状态', 'Verification'],
  'ui.completionState.verified': ['验收通过', 'Verified'],
  'ui.completionState.unverified': ['尚未验证', 'Not verified'],
  'ui.completionState.needs_review': ['需要审查', 'Needs review'],
  'ui.completionState.limited': ['达到修复限制', 'Repair limit reached'],
  'ui.completionObjective': ['目标：{objective}', 'Objective: {objective}'],
  'ui.completionSteps': ['步骤 {done}/{total} 已完成', '{done} of {total} step(s) done'],
  'ui.completionRepairs': ['已修复 {used}/{max} 轮', '{used} of {max} repair round(s) used'],
  'ui.completionUnfinished': ['未完成步骤：{steps}', 'Unfinished steps: {steps}'],
  'ui.completionFailedChecks': ['未通过的检查：{checks}', 'Failed checks: {checks}'],
  'ui.completionRunEnded': ['本轮已结束', 'This run has ended'],
  'ui.completionNoContract': [
    '本次运行没有验收契约：上面是本轮的回答，不代表需求已被验证。',
    'This run carried no acceptance contract: the answer above is not evidence that the request was met.',
  ],
  'ui.sessionUsage': ['会话用量统计', 'Session usage'],
  'settings.keyStoredLocally': [
    '密钥将使用系统加密存储保存在本机。',
    'The key is stored with system encryption on this device.',
  ],
  'ui.welcomeStart': ['从一个任务开始。', 'Start with a task.'],
  'ui.welcomeSubtitle': [
    '读懂项目，梳理思路，让改动逐步落地。',
    'Understand the project, plan the work, and make changes step by step.',
  ],
  'ui.exploreProject': ['认识这个项目', 'Explore this project'],
  'ui.learnFolders': ['了解目录与关键文件 ↗', 'Learn the folders and key files ↗'],
  'ui.findHowToRun': ['找到运行方式', 'Find how to run it'],
  'ui.startWithGuide': ['从项目说明开始 ↗', 'Start with the project guide ↗'],
  'ui.ready': ['准备就绪', 'Ready'],
  /**
   * The run status line, one entry per state it can be in.
   *
   * These were literals in `renderer.ts` that only the DOM walker could translate, and four of the eleven were
   * not in this dictionary at all — so an English interface showed `正在处理`, `等待你的确认`, `连接未就绪` and
   * `正在加载会话…` in Chinese while both gates passed. `idle` reuses `ui.ready` rather than repeating it, because
   * two entries with the same Chinese source and different English wording is the same bug in a different place.
   */
  'ui.runStatus.running': ['正在处理', 'Working'],
  'ui.runStatus.completed': ['本轮已结束', 'This turn is finished'],
  'ui.runStatus.needsReview': ['验收未通过，需检查', 'Acceptance failed; review needed'],
  'ui.runStatus.cancelled': ['已停止', 'Stopped'],
  'ui.runStatus.limited': ['已达到运行限制', 'The run limit was reached'],
  'ui.runStatus.failed': ['运行失败', 'The run failed'],
  'ui.runStatus.compacting': ['正在整理上下文…', 'Tidying up the context…'],
  'ui.runStatus.awaitingApproval': ['等待你的确认', 'Waiting for your confirmation'],
  'ui.runStatus.connecting': ['连接未就绪', 'The connection is not ready'],
  'ui.runStatus.loadingSession': ['正在加载会话…', 'Loading the session…'],
  /**
   * The exported conversation.
   *
   * A file is the one surface the DOM walker cannot reach, so the words have to be chosen where the file is
   * written; the export used to be Chinese whatever the interface language was.
   */
  'ui.export.untitled': ['新会话', 'New session'],
  'ui.export.roleUser': ['你', 'You'],
  'ui.export.roleAssistant': ['助手', 'Assistant'],
  'ui.export.roleTool': ['工具', 'Tool'],
  'ui.composerHint': [
    'Enter 发送 · Shift + Enter 换行',
    'Enter to send · Shift + Enter for a new line',
  ],
  // The right-hand workspace panel. Its labels live here rather than in the markup because the panel is
  // built at runtime: a Chinese string written into index.html and never translated is exactly the leak the
  // language sweep exists to catch, and it would only be caught on the surfaces the sweep opens.
  'workspace.title': ['工作区文件', 'Workspace files'],
  'workspace.treeLabel': ['工作区文件树', 'Workspace file tree'],
  'workspace.open': ['文件', 'Files'],
  'workspace.openTitle': ['显示工作区文件', 'Show workspace files'],
  'workspace.refresh': ['刷新', 'Refresh'],
  'workspace.refreshTitle': ['刷新文件和目录', 'Refresh files and folders'],
  'workspace.resize': ['拖拽调整侧栏宽度', 'Drag to resize sidebar'],
  'workspace.tabs': ['工作区标签', 'Workspace tabs'],
  'workspace.closeTab': ['关闭 {name}', 'Close {name}'],
  'workspace.close': ['收起', 'Hide'],
  'workspace.closeTitle': ['收起文件面板', 'Hide the file panel'],
  'workspace.loading': ['正在读取…', 'Reading...'],
  'workspace.emptyDirectory': ['空目录', 'Empty directory'],
  'workspace.truncated': [
    '条目过多，仅显示前 {count} 项',
    'Too many entries; showing the first {count}',
  ],
  'workspace.error': ['读取失败：{message}', 'Could not read: {message}'],
  'workspace.back': ['返回文件树', 'Back to files'],
  'workspace.fullscreen': ['全屏', 'Fullscreen'],
  'workspace.fullscreenTitle': ['全屏阅读', 'Read in fullscreen'],
  'workspace.exitFullscreen': ['退出全屏', 'Exit fullscreen'],
  'workspace.pathLabel': ['当前文件路径', 'Current file path'],
  'workspace.source': ['源码', 'Source'],
  'workspace.read': ['阅读', 'Read'],
  'workspace.previewing': ['正在读取文件…', 'Reading the file...'],
  'workspace.emptyFile': ['空文件', 'Empty file'],
  'workspace.shownOfTotal': ['仅显示前 {shown}，共 {total}', 'Showing {shown} of {total}'],
  'workspace.imageAlt': ['文件预览', 'File preview'],
  'workspace.unsupported.binary': ['二进制文件，无法以文本预览', 'Binary file, no preview'],
  'workspace.unsupported.too-large': [
    '图片超过预览上限（{limit}），未显示',
    'Image is larger than the preview limit ({limit})',
  ],
  'workspace.unsupported.not-a-file': ['这不是一个文件', 'This is not a file'],
  'workspace.unsupported.other': ['无法预览此文件', 'This file cannot be previewed'],
  /**
   * Text the *main* process shows: the settings page's validation and failure messages, and the dialogs it can
   * raise. They are in this dictionary because they reach a person, which is the whole test for belonging here —
   * the prompts built in `attachment-contract.ts` are instructions to the model and stay as they are.
   */
  'settings.baseUrlInvalid': [
    '接口地址需为 HTTPS 根地址或 /v1 地址，不可包含账号、查询参数或片段；本机调试可用 HTTP。',
    'The endpoint must be an HTTPS root or /v1 URL, with no credentials, query or fragment in it. HTTP is allowed for local debugging.',
  ],
  'settings.environmentProblems': [
    '启动环境中的设置无法生效：{problems}',
    'Settings from the launch environment cannot take effect: {problems}',
  ],
  'settings.modelLoadFailed': [
    '已保存的模型配置无法读取或解密，请重新填写密钥并保存。',
    'The saved model settings could not be read or decrypted. Enter the API key again and save.',
  ],
  'settings.connectionMissing': [
    '模型连接不存在，请重新选择。',
    'That model connection does not exist any more; choose another one.',
  ],
  'settings.modelRequestInvalid': ['无效的模型配置请求', 'Invalid model settings request'],
  'settings.modelConfigInvalid': ['无效的模型配置', 'Invalid model settings'],
  'settings.modelRequired': ['请填写模型 ID。', 'Enter a model ID.'],
  'settings.apiKeyRequired': ['请填写 API 密钥。', 'Enter an API key.'],
  'settings.apiKeyRequiredAfterChange': [
    '接口地址或协议已改变，请重新输入对应接口的 API 密钥。',
    'The endpoint or protocol changed; enter the API key that belongs to the new one.',
  ],
  'settings.connectionLimit': [
    '最多可保存 100 个模型连接。',
    'At most 100 model connections can be saved.',
  ],
  'settings.deleteActiveConnection': [
    '请先应用另一个连接，再删除当前连接。',
    'Select another connection before deleting the active one.',
  ],
  'settings.encryptionUnavailable': [
    '系统加密存储不可用，无法保存密钥。可暂时通过环境变量配置。',
    'System encryption is unavailable, so the key cannot be saved. Environment variables can be used in the meantime.',
  ],
  'settings.encryptionFailed': [
    '系统密钥加密失败，原配置未修改。',
    'Encrypting the API key failed; the previous settings are unchanged.',
  ],
  'settings.saveFailed': [
    '模型配置保存失败，请检查应用数据目录权限。',
    'Saving the model settings failed; check the permissions of the application data directory.',
  ],
  'settings.connectionTestCancelled': [
    '连接测试已取消或超时，请检查接口地址和网络。',
    'The connection test was cancelled or timed out; check the endpoint and the network.',
  ],
  'settings.connectionTestFailed': ['连接测试失败。', 'The connection test failed.'],
  'ui.settingsRequestInvalid': ['无效的通用设置请求', 'Invalid interface settings request'],
  'ui.settingsInvalid': ['无效的通用设置', 'Invalid interface settings'],
  'desktop.quitting': ['桌面正在退出。', 'The desktop is shutting down.'],
  'desktop.startWithNode': [
    '请通过 npm run desktop 启动，或指定真实 Node 24 的 YUANTU_NODE_PATH。',
    'Start this with `npm run desktop`, or point YUANTU_NODE_PATH at a real Node 24.',
  ],
  'desktop.exitFailureTitle': ['YuanTu 退出异常', 'YuanTu exited unexpectedly'],
  'desktop.startFailureTitle': ['YuanTu 启动失败', 'YuanTu failed to start'],
  'desktop.exportTitle': ['导出会话', 'Export session'],
  'desktop.textFilter': ['文本', 'Text'],
  'desktop.chooseWorkspaceTitle': ['选择工作目录', 'Choose a workspace directory'],
  'attach.busy': [
    '正在读取附件，请稍候',
    'An attachment is still being read; try again in a moment.',
  ],
  'attach.invalid': ['附件无效或超过 20MB', 'That attachment is invalid or larger than 20MB.'],
  'attach.timeout': [
    '文件读取超时，请拆分文件后重试',
    'Reading the file timed out; split it and try again.',
  ],
  'attach.readFailed': [
    '文件读取失败，请检查格式或文件是否损坏',
    'The file could not be read; check its format or whether it is damaged.',
  ],
  'attach.workerExited': [
    '文件读取进程已退出，请重试',
    'The file-reading process exited; try again.',
  ],
  'attach.failed': ['文件读取失败', 'Reading the file failed'],
  'attach.emptyFile': ['文件为空', 'The file is empty'],
  'attach.tooLarge': ['文件不能超过 20MB', 'The file cannot be larger than 20MB'],
  'attach.pdfTooManyPages': [
    'PDF 超过 200 页，请拆分文件',
    'The PDF has more than 200 pages; split it',
  ],
  'attach.textTooLong': [
    '文件内容超过 60000 字符，请拆分文件',
    'The extracted text is longer than 60000 characters; split the file',
  ],
  'attach.pdfNoText': [
    'PDF 未提取到文字，扫描件请转换为图片或先进行 OCR',
    'No text was extracted from the PDF; convert a scan to an image, or run OCR first',
  ],
  'attach.excelTooManySheets': [
    'Excel 超过 50 个工作表，请拆分文件',
    'The workbook has more than 50 sheets; split the file',
  ],
  'attach.excelTooLarge': [
    'Excel 工作表超过 1000 行或 100 列，请拆分文件',
    'A sheet has more than 1000 rows or 100 columns; split the file',
  ],
  'attach.binary': ['文件不是可读取的文本', 'The file is not readable text'],
  'attach.unsupported': [
    '不支持此格式，请使用 PDF、DOCX、XLSX、XLS 或文本代码文件',
    'That format is not supported; use PDF, DOCX, XLSX, XLS or a text or code file',
  ],
  'attach.emptyContent': ['未提取到可读取的文字', 'No readable text was extracted'],
  /**
   * The refusals the renderer makes itself, while a person is attaching files.
   *
   * They are dictionary entries rather than literals for the same reason the kernel's are: whatever is shown has
   * to be chosen in the language the interface is in. `attach.rendererFailure` puts the file's own name in front
   * of one of them, and the separator is part of the pattern rather than a literal concatenation, because which
   * punctuation separates a name from a sentence is a choice each language makes.
   */
  'attach.rendererCount': [
    '每条消息最多附加 8 个文件（其中图片最多 4 张）',
    'A message can carry at most 8 files, and at most 4 of them can be images',
  ],
  'attach.rendererImageBytes': ['单张图片不能超过 5MB', 'One image cannot be larger than 5MB'],
  'attach.rendererImageRead': ['图片读取失败', 'Reading the image failed'],
  'attach.rendererDocumentBytes': ['单个文件不能超过 20MB', 'One file cannot be larger than 20MB'],
  'attach.rendererFailure': ['{name}：{message}', '{name}: {message}'],
  /**
   * The refusals an image gets when the connection cannot accept one.
   *
   * Three wordings of the same situation exist, and the dictionary is keyed by the text itself (`domText` is
   * derived from these entries), so each one needs its own line or the variant that is not listed stays Chinese in
   * an English interface — which is what happened: the two kernel messages and the renderer's own were all absent
   * here while every gate passed, because the renderer is exempt from the scan on the grounds that the walker
   * translates it, and the walker only translates what this file already contains.
   *
   * Keeping the kernel's text in Chinese is deliberate rather than an oversight: the CLI reads those errors with
   * no dictionary in its process and is Chinese-first, so the fix belongs here, where a person's locale is known.
   */
  'attach.visionRequired': [
    '当前连接未启用图片输入，请选择支持视觉的模型。',
    'This connection has no image input; choose a model that supports vision.',
  ],
  'attach.visionRequiredMidRun': [
    '当前连接未启用图片输入；请切换视觉模型或新建纯文本会话。',
    'This connection has no image input; switch to a vision model or start a new text-only session.',
  ],
  'attach.visionModelRequired': [
    '当前模型未启用图片输入，请切换支持图片的模型',
    'This model has no image input; switch to a model that supports images.',
  ],
  'settingsMain.busy': [
    '请等待当前操作结束后再测试或保存配置。',
    'Wait for the current operation to finish before testing or saving settings.',
  ],
  'settingsMain.connectionDeleted': ['连接已删除。', 'The connection was deleted.'],
  'settingsMain.modelsRead': ['已读取 {count} 个模型。', 'Read {count} models.'],
  'settingsMain.testSucceeded': [
    '连接成功，模型已返回响应。测试不会保存配置。',
    'Connected: the model answered. The test does not save the configuration.',
  ],
  'settingsMain.saved': [
    '模型配置已保存并生效，可以开始聊天。',
    'The model settings are saved and active; you can start chatting.',
  ],
  'settingsMain.savedCleanupWarning': [
    '模型配置已保存并生效，但旧进程退出异常，请检查残留进程。',
    'The model settings are saved and active, but the previous process exited badly; check for leftover processes.',
  ],
  'mcpMain.cancelAuthorize': ['已取消 MCP 授权。', 'MCP authorization cancelled.'],
  'mcpMain.authorizeInProgress': [
    '已有 MCP 授权正在进行，请先取消或等待它完成。',
    'An MCP authorization is already in progress; cancel it or wait for it to finish.',
  ],
  'mcpMain.busy': [
    '请等待当前操作结束后再修改或测试 MCP。',
    'Wait for the current operation to finish before changing or testing MCP.',
  ],
  'mcpMain.testSucceeded': [
    '连接成功，发现 {count} 个工具。测试未保存配置。',
    'Connected: {count} tools found. The test did not save the configuration.',
  ],
  'mcpMain.authorizeUrlInvalid': [
    'MCP 授权地址必须是 http 或 https 链接。',
    'The MCP authorization URL must be an http or https link.',
  ],
  'mcpMain.authorizeSucceeded': [
    'MCP 授权完成，浏览器中的授权页现在可以关闭。授权凭证保存在当前用户账户下，仅对本机用户生效。',
    'MCP authorization is complete; the browser page can be closed. The credential is stored for the current user account on this machine only.',
  ],
  'mcpMain.saved': [
    'MCP 配置已保存，下一轮对话生效。',
    'MCP configuration saved; it applies to the next turn.',
  ],
  'mcpMain.deleted': ['MCP 服务已删除。', 'The MCP server was deleted.'],
  'mcpMain.revoked': ['MCP 授权已撤销。', 'The MCP authorization was revoked.'],
};
/**
 * The DOM walker matches on already-rendered text, so it needs a Chinese to
 * English index of the dictionary. Keeping it derived means every string has
 * exactly one definition and cannot drift between two tables.
 */
const domText = new Map<string, string>();
for (const pair of Object.values(messages)) domText.set(pair[0], pair[1]);
const listeners = new Set<Listener>();
let language: UiLanguage = 'zh-CN';
export function format(template: string, values: TranslationValues = {}): string {
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (m, k: string) =>
    Object.hasOwn(values, k) ? String(values[k]) : m,
  );
}
export function translate(key: string, lang: UiLanguage, values?: TranslationValues): string {
  const pair = messages[key];
  return format(pair ? pair[lang === 'en-US' ? 1 : 0] : key, values);
}
export function t(key: string, values?: TranslationValues): string {
  return translate(key, language, values);
}
export function locale(): UiLanguage {
  return language;
}
/**
 * The language the *main* process renders its own text in.
 *
 * A second piece of state rather than the renderer's `language` because these are two processes: the renderer
 * learns the interface language from the page it is drawing, and the main process from the settings file it
 * reads before a window exists — a failure dialog can be raised while a run is starting, before the renderer has
 * loaded anything. They read the same dictionary, which is the point: a validation message and the label beside
 * it cannot disagree about which language the interface is in.
 *
 * Until somebody sets it, it is the same default the renderer starts from.
 */
let mainLanguage: UiLanguage = 'zh-CN';
export function setMainLocale(next: UiLanguage): void {
  mainLanguage = next;
}
/** `t` for the main process: the same dictionary, read in the language this process was last told about. */
export function mainText(key: string, values?: TranslationValues): string {
  return translate(key, mainLanguage, values);
}
const originals = new WeakMap<Node, string>();
const applied = new WeakMap<Node, string>();
const attributeSources = new WeakMap<Element, Map<string, { original: string; applied: string }>>();
const translatedAttributes = ['placeholder', 'aria-label', 'title'];
const excludedContent = 'script,style,pre,code,.message-content,[translate="no"]';
let observing = false;
function translatedText(value: string): string {
  if (language === 'zh-CN') return value;
  const m = value.match(/^(\s*)(.*?)(\s*)$/s)!;
  let body = domText.get(m[2]!) ?? m[2]!;
  body = body
    .replace(/^◇\s+MCP 服务$/, '◇ MCP Services')
    .replace(/^会话操作[：:]\s*(.+)$/, 'Session actions: $1')
    .replace(/^会话 ([a-f0-9]{1,8})$/i, 'Session $1')
    .replace(
      /^项目规则 (\d+) · 技能 (\d+) · 扩展 (\d+)$/,
      'Project rules $1 · Skills $2 · Extensions $3',
    )
    .replace(/^会话改动 · (\d+) 次文件操作$/, 'Session changes · $1 file operations')
    .replace(/^正在执行 (.+)$/, 'Running $1')
    .replace(/^当前工作区：/, 'Current workspace: ')
    .replace(/ · 已停用 · /g, ' · Disabled · ');
  return m[1] + body + m[3];
}
function translateDocument(root: Node): void {
  const nodes: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) nodes.push(n);
  }
  for (const node of nodes) {
    if (node.parentElement?.closest(excludedContent)) continue;
    const current = node.textContent ?? '';
    if (!originals.has(node) || (applied.has(node) && applied.get(node) !== current))
      originals.set(node, current);
    const next = translatedText(originals.get(node)!);
    if (current !== next) node.textContent = next;
    applied.set(node, next);
  }
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
    const elements =
      root instanceof Element
        ? [root, ...root.querySelectorAll('*')]
        : [...(root as Document).querySelectorAll('*')];
    for (const element of elements) {
      if (element.closest(excludedContent)) continue;
      let sources = attributeSources.get(element);
      if (!sources) attributeSources.set(element, (sources = new Map()));
      for (const attribute of translatedAttributes) {
        const value = element.getAttribute(attribute);
        if (value === null) {
          sources.delete(attribute);
          continue;
        }
        const previous = sources.get(attribute);
        const original = !previous || previous.applied !== value ? value : previous.original;
        const next = translatedText(original);
        sources.set(attribute, { original, applied: next });
        if (value !== next) element.setAttribute(attribute, next);
      }
    }
  }
}
export function setLocale(next: UiLanguage): void {
  language = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    translateDocument(document);
    if (!observing && document.body) {
      observing = true;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) translateDocument(n);
          if (r.type === 'characterData') translateDocument(r.target);
          if (r.type === 'attributes') translateDocument(r.target);
        }
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: translatedAttributes,
      });
    }
  }
  for (const listener of listeners) listener();
}
export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
