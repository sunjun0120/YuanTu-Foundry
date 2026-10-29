/**
 * One part of the desktop dictionary; `./i18n.ts` joins the parts in this order and owns the lookup.
 *
 * Every entry is a `[zh-CN, en-US]` pair, so the two languages of one string are always edited together.
 */
/** The conversation: the composer, commands, plans, sub-agents and their transcript. */
export const conversationMessages: Record<string, [string, string]> = {
  'ui.loadOlderHistory': [
    '加载更早的消息（还有 {count} 条）',
    'Load earlier messages ({count} remaining)',
  ],
  'settings.description': [
    '管理模型连接，为每次对话选择合适的模型。',
    'Manage model connections and choose a model for each conversation.',
  ],
  'settings.noModel': ['尚无模型', 'No models'],
  'settings.modelEntry': ['模型设置', 'Model settings'],
  'settings.environmentModel': ['{model}（环境变量）', '{model} (environment)'],
  'settings.protocolOpenai': ['OpenAI Chat Completions', 'OpenAI Chat Completions'],
  'settings.protocolAnthropic': ['Anthropic Messages', 'Anthropic Messages'],
  'settings.protocolResponses': ['OpenAI Responses', 'OpenAI Responses'],
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
  'settings.modelNote': ['填写接口支持的模型', 'Enter a model supported by the endpoint'],
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
  'ui.untitledSession': ['新会话', 'New session'],
  'ui.workspace': ['工作区', 'Workspace'],
  'ui.changeFolder': ['更换目录', 'Change folder'],
  'ui.recentSessions': ['最近会话', 'Recent sessions'],
  'statistics.hostLabel': ['会话用量统计', 'Session usage statistics'],
  'statistics.sessionTitle': ['会话统计', 'Session statistics'],
  'statistics.tokensTitle': ['Token 用量', 'Token usage'],
  'statistics.modelTime': ['模型用时', 'LLM time'],
  'statistics.toolsApprovals': ['工具与确认用时', 'Tools + approvals'],
  'statistics.ttft': ['首 token 平均（TTFT）', 'Avg time to first token (TTFT)'],
  'statistics.tps': ['输出速度（TPS）', 'Tokens per second (TPS)'],
  'statistics.cacheHit': ['缓存命中', 'Cache hit'],
  'statistics.uncachedInput': ['未缓存输入', 'Uncached input'],
  'statistics.cachedInput': ['缓存读取', 'Cached input'],
  'statistics.cacheWrite': ['缓存写入', 'Cache write'],
  'statistics.output': ['输出', 'Output'],
  'statistics.counts': [
    '本会话累计 {turns} 轮 {steps} 步',
    'This session: {turns} turns {steps} steps',
  ],
  'statistics.runTotal': ['本次 {total}', 'This run {total}'],
  'statistics.sessionTotal': [
    '本会话累计 {total} tok（含缓存读取）',
    'Session total {total} tok (incl. cache reads)',
  ],
  'statistics.cacheHitPill': ['缓存命中 {percent}%', 'Cache hit {percent}%'],
  'statistics.longContext': [
    '上下文已较长，新建会话可降低后续开销',
    'Long context: a new session lowers the cost of later turns',
  ],
  'statistics.seconds': ['{value}秒', '{value}s'],
  'statistics.minutes': ['{minutes}分{seconds}秒', '{minutes}m{seconds}s'],
  'ui.attachmentsLabel': ['待发送附件', 'Attachments to send'],
  'ui.attachmentCharacters': ['{count} 字符', '{count} characters'],
  'ui.removeAttachment': ['移除附件 {name}', 'Remove attachment {name}'],
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
  'ui.toolCardSandboxFork': [
    '沙箱无法创建子进程（spawn EPERM），这是环境限制，不是命令或代码错误。可改用直接运行测试文件，或在“完全访问权限”下重试。',
    'The sandbox could not create a child process (spawn EPERM). This is an environment limit, not a failing command or test. Run the test file directly, or retry with “Full access”.',
  ],
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
  'ui.createGoal': ['创建任务草稿', 'Create task draft'],
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
  'command.goalDescription': [
    '把描述变成可编辑、可执行的任务草稿',
    'Turn the description into an editable, executable task draft',
  ],
  'command.planDescription': [
    '只读探索后给出计划，人工批准才执行',
    'Read-only exploration, then a plan that needs human approval to run',
  ],
  'skill.codeAnalysisReportDescription': [
    '用内置代码分析服务分析源码包或 GitHub 仓库，并写出有据可查的分析报告。',
    'Analyse source archives or GitHub repositories with the built-in code analysis service and write evidence-based reports.',
  ],
  'ui.copy': ['复制代码', 'Copy code'],
  'ui.copied': ['已复制', 'Copied'],
  'ui.copyFailed': ['复制失败', 'Copy failed'],
  'ui.openLinkFailed': ['打开链接失败', 'Failed to open link'],
  'ui.openWorkspaceFile': ['打开工作区文件', 'Open workspace file'],
  'ui.openWithDefaultApp': ['用默认应用打开', 'Open with default app'],
  'ui.revealInFolder': ['显示所在文件夹', 'Show in folder'],
  'ui.image': ['图片', 'Image'],
  'ui.imageNotLoaded': ['未加载', 'not loaded'],
  'ui.removeImage': ['移除 {name}', 'Remove {name}'],
  'ui.sendTimeUnavailable': ['这条消息未记录发送时间', 'Send time unavailable for this message'],
  'ui.copyMessage': ['复制问题', 'Copy message'],
  'ui.operationFailed': ['操作未完成', 'Operation failed'],
  'ui.unanswered.shutdown': [
    '运行在应用关闭时中断，未产生回答。',
    'The run was interrupted when the application closed, without an answer.',
  ],
  'ui.unanswered.user': ['已停止，未产生回答。', 'Stopped without an answer.'],
  'ui.unanswered.cancelled': [
    '运行已中断或停止，未产生回答。',
    'The run was interrupted or stopped without an answer.',
  ],
  'ui.unanswered.crash': [
    '运行因应用异常退出而中断。',
    'The run was interrupted by an unexpected application exit.',
  ],
  'ui.toolArgumentsInvalid': [
    '工具参数不符合它自己的定义（多传或漏传了字段），这次调用没有执行。下面是原始诊断。',
    'The tool arguments did not match the tool definition (a field was missing or extra), so the call did not run. The raw diagnostic follows.',
  ],
  'ui.toolPermissionPolicy': [
    '这次调用被会话的权限预设拦下（例如「仅可查看」），没有执行，也没有询问你。要改的是预设或所需权限。',
    'The session’s permission preset blocked this call (for example a read-only preset). It did not run, and nobody was asked. Change the preset or the permission it needs.',
  ],
  'ui.toolCheckLocked': [
    '验收检查已经登记，不能替换成更容易通过的检查；要让它通过，需要修复工作本身。',
    'The acceptance checks are registered and cannot be replaced by easier ones; passing them means fixing the work.',
  ],
  'ui.toolApprovalUnavailable': [
    '当前没有可用的审批端，这次调用没有执行。',
    'No approval responder is available. This call did not run.',
  ],
  'ui.toolApprovalTimedOut': [
    '等待审批超时，这次调用没有执行。',
    'The approval request timed out. This call did not run.',
  ],
  'ui.toolApprovalDenied': [
    '你拒绝了这次调用，因此没有执行。',
    'You denied this call, so it did not run.',
  ],
  'ui.toolGitOutsideWorkspace': [
    'Git 工具要求仓库根目录在工作区内；当前工作区是某个仓库的子目录。',
    'Git tools need the repository root inside the workspace; this workspace is a subdirectory of one.',
  ],
  /**
   * Two preparation stages that refuse before a command starts, kept apart because the fix differs: one is the
   * account setup, the other is this workspace's access grant. The raw result stays below and carries the path,
   * the failed stage and the helper's own error, which is what makes either one actionable.
   */
  'ui.toolSandboxInitialization': [
    'Windows 沙箱账户初始化没有完成，命令没有启动。下面保留了 helper 路径与底层错误。',
    'Windows sandbox account initialization did not finish, so the command never started. The raw text names the helper and the error underneath.',
  ],
  'ui.toolSandboxAuthorization': [
    '工作区授权没有完成，命令没有启动。下面保留了失败阶段、具体路径与底层错误。',
    'Workspace authorization did not finish, so the command never started. The raw text names the failed stage, the path and the error underneath.',
  ],
  /**
   * A dead Windows sandbox lease: every command is refused until the workspace permissions it left are put back.
   * The kernel's own sentence ends by naming a CLI the desktop does not install, so the window replaces it with
   * what a person can act on — one button, and what happened after pressing it.
   */
  'ui.sandboxBlocked': [
    'Windows 沙箱留下了未清理的工作区权限记录，命令已暂停。修复后即可继续，不需要打开终端或安装其他工具。',
    'The Windows sandbox left workspace permissions behind, so commands are paused. Repairing them is enough to continue — no terminal or extra install needed.',
  ],
  'ui.sandboxRecoveryAction': ['修复工作区权限', 'Fix workspace permissions'],
  'ui.sandboxRecovering': ['正在修复…', 'Repairing…'],
  'ui.sandboxRecovered': [
    '已恢复 {count} 个工作区的权限，可以重新运行命令。',
    'Restored permissions for {count} workspace(s); commands can run again.',
  ],
  'ui.sandboxRecoveryNothing': ['没有需要恢复的权限记录。', 'There was nothing to restore.'],
  'ui.sandboxRecoveryFailed': ['修复失败：{message}', 'Repair failed: {message}'],
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
  'approval.sectionLabel': ['待审批操作', 'Pending approvals'],
  'approval.title.command': ['执行命令', 'Run a command'],
  'approval.title.write': ['修改文件', 'Change files'],
  'approval.title.external': ['访问外部服务', 'Use an external service'],
  'approval.why.command': [
    'Agent 想通过 {tool} 运行下面的命令。命令可能修改文件或产生其他影响，所以要先征得你同意。',
    'The agent wants to run the command below through {tool}. A command can change files or have other effects, so it needs your consent first.',
  ],
  'approval.why.write': [
    'Agent 想通过 {tool} 写入工作区文件。下面是将要写入的内容，确认无误再允许。',
    'The agent wants to write workspace files through {tool}. The content to be written is below; allow it once it looks right.',
  ],
  'approval.why.external': [
    'Agent 想通过 {tool} 访问外部服务，相关内容可能发送到本机以外。',
    'The agent wants to use an external service through {tool}; the request may send data off this machine.',
  ],
  'approval.directory': ['运行目录：{directory}', 'Directory: {directory}'],
  'approval.identicalCount': [
    '同一操作有 {count} 个请求在等待，这次选择会一并应用。',
    '{count} identical requests are waiting; this answer applies to all of them.',
  ],
  'approval.boundary': ['隔离：{files}；{network}。', 'Isolation: {files}; {network}.'],
  'approval.files.unrestricted': [
    '直接在本机运行，没有系统隔离，可读写当前账户能访问的任何文件',
    'runs on this machine with no operating-system isolation and can read or change any file this account can',
  ],
  'approval.files.workspace-write-partial': [
    '在受限 Windows 令牌下运行，写入只部分限制在工作区内，且可以读取本机任意文件',
    'runs under a restricted Windows token; writes are only partly confined to the workspace and it can read files anywhere on this machine',
  ],
  'approval.files.read-only': ['在沙箱中运行，不能写文件', 'runs sandboxed with no file writes'],
  'approval.files.workspace-write': [
    '在沙箱中运行，只能写入工作区',
    'runs sandboxed; file writes are confined to the workspace',
  ],
  'approval.network.denied': ['网络访问已阻止', 'network access is blocked'],
  'approval.network.unrestricted': ['可以访问网络', 'it can reach the network'],
  'approval.escalation.network': [
    '这条命令请求临时联网，当前会话默认断网。',
    'This command asks for the network, which this session otherwise blocks. ',
  ],
  'approval.raw': ['完整操作参数', 'Full operation details'],
  'approval.allow': ['允许一次', 'Allow once'],
  'approval.projectConfig.commands': [
    '这是项目的命令入口配置：改这里的脚本会改变以后运行测试、构建或安装的方式。',
    'This is the project command entry point: editing its scripts changes how tests, builds or installs run from now on.',
  ],
  'approval.projectConfig.build': [
    '这是项目的构建/CI 配置：改动会影响以后每次构建或推送。',
    'This is project build/CI configuration: the change affects every later build or push.',
  ],
  'approval.allowSession': ['本会话允许此类操作', 'Allow this for the session'],
  'approval.allowSessionNote': [
    '完全相同的命令在本会话内不再询问；参数不同的命令仍会询问。',
    'The same command will not ask again in this session; a command with different arguments still will.',
  ],
  'approval.deny': ['拒绝', 'Deny'],
  'ui.externalService': ['访问外部服务', 'Access external service'],
  'ui.runCommand': ['执行命令', 'Run command'],
  'ui.modifyFiles': ['修改文件', 'Modify files'],
  'ui.fullDetails': ['完整操作参数', 'Full operation details'],
  'ui.allowOnce': ['允许一次', 'Allow once'],
  'ui.deny': ['拒绝', 'Deny'],
  'ui.undoChange': ['撤销此修改', 'Undo this change'],
  /**
   * The one question the product writes itself, in plan mode.
   *
   * The kernel sends this question in English because it also writes it for the model; only the fixed header, the
   * short prompt, the two options and their descriptions are translated here, for display. The option *value* the
   * renderer sends back stays the kernel's label — `plan-tools.ts` matches it exactly.
   */
  'question.plan.header': ['计划批准', 'Plan approval'],
  'question.plan.intro': [
    '批准这份计划，并在本轮开始执行吗？',
    'Approve this plan and start carrying it out in this run?',
  ],
  'question.plan.approve': ['批准并执行', 'Approve and execute'],
  'question.plan.keepPlanning': ['继续修改计划', 'Keep planning'],
  'question.plan.approveDescription': [
    '现在就解除只读模式，在本轮执行这份计划。',
    'Lift read-only mode now and carry out the plan in this run.',
  ],
  'question.plan.keepPlanningDescription': [
    '先不开始工作，继续停留在计划模式。',
    'Do not start work: stay in planning mode.',
  ],
  'plan.title': ['计划', 'Plan'],
  'plan.status.planning': ['正在制定计划', 'Planning in progress'],
  'plan.waitingAnswer': ['规划正在等待你的回答', 'Planning is waiting for your answer'],
  'plan.showQuestion': ['前往问题', 'Go to question'],
  'plan.status.planningIdle': ['计划模式 · 等待下一步', 'Plan mode · waiting'],
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
  /**
   * A planning row whose run has ended without proposing anything — usually a question back to the person, or a
   * write the planning run was not allowed to make. "正在制定计划" there promised work nobody was doing.
   */
  'plan.idleHint': [
    '这次运行没有产出计划。可以直接回复补充信息，让它继续制定；不想再计划就退出计划模式。',
    'This run did not produce a plan. Reply with more detail to keep planning, or leave plan mode.',
  ],
  'plan.exitMode': ['退出计划模式', 'Leave plan mode'],
  'plan.abandonedHint': [
    '制定这份计划的运行已中断，这份计划不会再完成；可以重新发起一次计划。',
    'The run that was preparing this plan was interrupted, so it will not finish. You can plan again.',
  ],
  'subagent.title': ['子代理', 'Sub-agents'],
  'subagent.catalogLabel': ['子代理会话', 'Sub-agent sessions'],
  'subagent.pageLabel': ['子代理记录', 'Sub-agent record'],
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
  'subagent.workspace.exporting': [
    '正在导出改动：{processed}/{total} 个文件',
    'Exporting changes: {processed}/{total} files',
  ],
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
  'ui.completionRepairSummary': [
    '自动验收未通过，已把失败原因发回给模型继续修复。详细检查结果见本轮“验收状态”。',
    'Automated checks did not pass; the model is being asked to repair the work. See the verification panel for the failed checks.',
  ],
  'ui.runPaused': ['提问已暂停', 'Paused'],
  /** The one action offered beside a stopped run: send one message that asks to carry on. */
  'ui.continueRun': ['继续', 'Continue'],
  'ui.continuePrompt': [
    '继续完成刚才中断的任务，从中断处接着做。',
    'Continue the interrupted task from where it stopped.',
  ],
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
  'ui.loadMoreSessions': ['加载更早的会话', 'Show older sessions'],
  'ui.showMoreSessions': ['显示更多', 'Show more'],
  'ui.showFewerSessions': ['收起', 'Show less'],
  'ui.sessionRunning': ['运行中', 'Running'],
  'ui.sessionWaitingLabel': [
    '该会话有 {count} 项审批或提问等待处理，打开会话后处理',
    'This session has {count} approvals or questions waiting; open it to answer',
  ],
  'ui.commandNeedsDescription': ['/{name} 需要描述内容。', '/{name} requires a description.'],
  'ui.maxImages': ['每条消息最多附加 4 张图片', 'Each message can include at most 4 images'],
  'ui.maxImageTotal': ['图片合计不能超过 10MB', 'Images must total no more than 10 MB'],
  'ui.maxImage': ['单张图片不能超过 5MB', 'Each image must be no larger than 5 MB'],
  'ui.imageReadFailed': ['图片读取失败', 'Failed to read image'],
  'ui.connectionInterrupted': [
    '桌面连接中断，请重新启动后检查会话记录。',
    'Desktop connection interrupted. Restart it and check the session history.',
  ],
};
