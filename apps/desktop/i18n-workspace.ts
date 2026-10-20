/**
 * One part of the desktop dictionary; `./i18n.ts` joins the parts in this order and owns the lookup.
 *
 * Every entry is a `[zh-CN, en-US]` pair, so the two languages of one string are always edited together.
 */
/** Sessions, diffs, the welcome screen, workspace files and model settings. */
export const workspaceMessages: Record<string, [string, string]> = {
  'session.actions': ['会话操作', 'Session actions'],
  'session.rename': ['重命名', 'Rename'],
  'session.archive': ['归档', 'Archive'],
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
  'ui.goalStandDown.no-progress': [
    '自动续跑已停止：最近一轮没有新的进展（共续跑 {rounds} 轮）。发送消息即可继续。',
    'Automatic rounds stopped: the last round made no new progress ({rounds} round(s) run). Send a message to continue.',
  ],
  'ui.goalStandDown.request-limit': [
    '自动续跑已停止：本次请求已续跑 {rounds} 轮，达到单次上限。发送消息即可继续。',
    'Automatic rounds stopped: this request ran {rounds} round(s), its limit. Send a message to continue.',
  ],
  'ui.goalStandDown.token-limit': [
    '自动续跑已停止：本次请求的续跑轮次已用完 token 预算（共续跑 {rounds} 轮）。发送消息即可继续。',
    'Automatic rounds stopped: this request’s rounds spent their token budget ({rounds} round(s) run). Send a message to continue.',
  ],
  'ui.deliverablesTitle': ['交付物', 'Deliverables'],
  'ui.openDeliverable': ['在工作区预览中打开', 'Open in the workspace preview'],
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
  'ui.automaticVerificationTitle': ['自动验证', 'Automatic verification'],
  'ui.verificationChecksPassed': ['检查通过', 'Checks passed'],
  'ui.verificationDetails': ['检查详情（{count}）', 'Check details ({count})'],
  'ui.verificationCheckPassed': ['通过', 'Passed'],
  'ui.verificationCheckFailed': ['未通过', 'Failed'],
  'ui.verificationExitCode': ['退出码：{code}', 'Exit code: {code}'],
  'ui.completionReason.missing-verification': [
    '尚未提供可执行的检查，结果未经验证。',
    'No executable checks were provided; the result is unverified.',
  ],
  'ui.completionState.verified': ['验收通过', 'Verified'],
  'ui.completionState.unverified': ['尚未验证', 'Not verified'],
  'ui.completionState.needs_review': ['需要审查', 'Needs review'],
  'ui.completionState.limited': ['达到修复限制', 'Repair limit reached'],
  'ui.completionObjective': ['目标：{objective}', 'Objective: {objective}'],
  'ui.completionSteps': ['步骤 {done}/{total} 已完成', '{done} of {total} step(s) done'],
  'ui.completionRepairs': ['已修复 {used}/{max} 轮', '{used} of {max} repair round(s) used'],
  'ui.completionUnfinished': ['未完成步骤：{steps}', 'Unfinished steps: {steps}'],
  'ui.completionFailedChecks': ['未通过的检查：{checks}', 'Failed checks: {checks}'],
  /**
   * Why a run is waiting for review, in the words a person acts on. The model's own "done" is not this: a run can
   * finish its answer and still hold a call whose effect nobody confirmed, and that is what the line says.
   */
  'ui.completionReason.pending-effects': [
    '有工具调用的结果尚未确认（例如命令可能已修改文件），请检查后再验收',
    'A tool call’s effect is not confirmed yet (a command may have changed files); check it before accepting',
  ],
  'ui.completionReason.manual-review': [
    '验收条件包含需要人工确认的项目',
    'The acceptance criteria include items a person has to confirm',
  ],
  'ui.completionReason.cancelled': [
    '运行被停止，结果未经验证',
    'The run was stopped before it was verified',
  ],
  'ui.completionReason.definition-changed': [
    '验收条件在运行中被修改，需要重新确认',
    'The acceptance criteria changed during the run and need to be confirmed again',
  ],
  'ui.completionReason.repeated-failure': [
    '同一检查反复失败，自动修复已停止',
    'The same check kept failing, so automatic repair stopped',
  ],
  'ui.completionReason.verification-changed-monitored-inputs': [
    '验证过程修改了被监控的输入文件，结果不可信',
    'Verification changed the files it was checking, so its result cannot be trusted',
  ],
  'ui.completionReason.empty-acceptance': [
    '没有可执行的验收条件',
    'There are no acceptance criteria that can be checked',
  ],
  'ui.completionReason.invalid-definition': [
    '验收条件无法执行，请检查其定义',
    'The acceptance criteria cannot be run; check how they are defined',
  ],
  'ui.completionReason.protected-path-changed': [
    '合同要求不得改动的文件被修改，需要人工审查',
    'A file the contract said must not change was modified; a person needs to review it',
  ],
  'ui.completionReason.superseded': [
    '本次修改后，之前的验证结果已失效，需要重新验证。',
    'The workspace changed after the previous verification, so that result no longer applies; verify it again.',
  ],
  'ui.completionReason.other': [
    '运行需要人工检查后才能视为完成',
    'The run needs a person to check it before it counts as done',
  ],
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
  'ui.runStatus.preparing': ['正在准备请求…', 'Preparing the request…'],
  'ui.runStatus.waitingModel': ['正在等待模型响应…', 'Waiting for the model…'],
  'ui.runStatus.responding': ['正在生成回复…', 'Writing the response…'],
  'ui.runStatus.tools': ['正在执行工具…', 'Running tools…'],
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
};
