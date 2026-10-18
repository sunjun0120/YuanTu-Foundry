import type { CarrierErrorCode } from '../../packages/carrier/errors.ts';

/**
 * One part of the desktop dictionary; `./i18n.ts` joins the parts in this order and owns the lookup.
 *
 * Every entry is a `[zh-CN, en-US]` pair, so the two languages of one string are always edited together.
 */
/** The carrier's error codes, one sentence each; typed so a new code cannot ship without words. */
export const carrierMessages: Record<`carrier.${CarrierErrorCode}`, [string, string]> = {
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
