import type { UiLanguage } from './ui-settings.ts';

type Listener = () => void;
export type TranslationValues = Record<string, string | number>;
type Pair = [string, string];
const messages: Record<string, Pair> = {
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
  'settings.contextTokens': ['上下文窗口 Token', 'Context window tokens'],
  'settings.outputTokens': ['单次输出上限 Token', 'Maximum output tokens per request'],
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
    '端点没有声明 {models} 的窗口，请按提供方规格填写。',
    'The endpoint declared no window for {models}; fill it from the provider specification.',
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
    '记录过长，只显示开头部分。',
    'The transcript was long, so only the beginning is shown.',
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
    if (node.parentElement?.closest('script,style,pre,.message-content')) continue;
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
      for (const attribute of ['placeholder', 'aria-label', 'title']) {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, translatedText(value));
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
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }
  for (const listener of listeners) listener();
}
export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
