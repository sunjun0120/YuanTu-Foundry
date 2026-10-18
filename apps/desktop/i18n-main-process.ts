/**
 * One part of the desktop dictionary; `./i18n.ts` joins the parts in this order and owns the lookup.
 *
 * Every entry is a `[zh-CN, en-US]` pair, so the two languages of one string are always edited together.
 */
/** Text the main process hands to the page: settings replies, hooks, attachments, quitting and MCP authorisation. */
export const mainProcessMessages: Record<string, [string, string]> = {
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
  'hookTrust.title': ['工作区钩子', 'Workspace hooks'],
  'hookTrust.message': [
    '此工作区声明了 {count} 条外部钩子命令。是否信任并启用？',
    'This workspace declares {count} external hook command(s). Trust and enable them?',
  ],
  'hookTrust.changed': [
    '钩子声明或其引用的工作区文件在上次信任后发生了变化，需要重新确认。',
    'The hook declarations or their referenced workspace files changed after you last trusted them and must be confirmed again.',
  ],
  'hookTrust.detail': [
    '工作区：{workspace}\n启用后，这些命令会在会话开始、提交消息、调用工具等时机自动运行，可能读取你的文件或访问网络。只信任你了解其来源的仓库。声明或其引用的工作区文件内容一旦改变会再次询问。',
    'Workspace: {workspace}\nOnce enabled, these commands run automatically when a session starts, a message is sent, a tool is called and so on, and may read your files or use the network. Only trust repositories whose source you know. You will be asked again if the declarations or their referenced workspace file contents change.',
  ],
  'hookTrust.unavailable': [
    '无法读取或保存信任记录（{detail}），本次不会启用这些钩子。',
    'The trust record cannot be read or saved ({detail}), so these hooks stay off this time.',
  ],
  'hookTrust.trust': ['信任并启用', 'Trust and enable'],
  'hookTrust.skip': ['本次不启用', 'Not this time'],
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
