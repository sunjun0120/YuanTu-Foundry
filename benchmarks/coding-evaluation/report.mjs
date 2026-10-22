import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { aggregateResults, distribution } from './metrics.mjs';

export async function writeReport({ input, manifest, outputDirectory = path.dirname(input) }) {
  const resolved = JSON.parse(await readFile(manifest, 'utf8'));
  const results = (await readFile(input, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const summary = aggregateResults(results, resolved.planned);
  const live = results.some((result) => result.live);
  const timing = distribution(
    results
      .filter((result) => !['blocked', 'invalid'].includes(result.outcome))
      .map((result) => result.wallMs),
  );
  const helped = results.filter((result) => result.humanInterventions.length).length;
  const text = [
    '# 内部真实编程评测报告',
    '',
    `批次：${resolved.batchId}；任务集：project-seeded-v1；模式：host；${live ? '真实模型任务' : '离线工装，真实模型任务未执行'}。`,
    `模型：${resolved.model ?? '未指定'}；协议：${resolved.protocol ?? '未指定'}；端点身份：${resolved.endpointId ?? '未指定'}；cache=${resolved.promptCache}；reasoning=${resolved.reasoning}。`,
    `完整性：${summary.complete ? '完整' : '不完整'}；预定 ${summary.plannedCount}，记录 ${summary.recordedCount}，passed ${summary.outcomes.passed}，blocked ${summary.outcomes.blocked}，invalid ${summary.outcomes.invalid}。`,
    `预定样本完成率：${live ? `${summary.outcomes.passed}/${summary.plannedCount}` : '不适用（无真实模型样本）'}；有效已启动完成率：${summary.validStartedRate ?? '不适用'}；无帮助完成率：${live ? summary.unassistedRate : '不适用'}；接受人工帮助样本：${helped}。`,
    `编程 E01–E08：${summary.groups.coding.passed}/${summary.groups.coding.planned}；操作 E09–E10：${summary.groups.operational.passed}/${summary.groups.operational.planned}。离线记录不表示产品失败率或成功率。`,
    `已启动样本耗时 ms：median=${timing.median ?? '未知'}，range=${timing.min ?? '未知'}–${timing.max ?? '未知'}，n=${timing.count}。三次重复不报告可靠p95。setup/verification/cleanup独立保存在逐次结果。`,
    `用量完整：${summary.usageComplete}；可确认费用：${summary.cost.amount ?? '未知'} ${summary.cost.currency ?? ''}。缺用量/计价/供应商硬上限时不得推定为0。${
      live
        ? `本批次发出过真实模型请求：输入 ${results.reduce((sum, result) => sum + (result.usage.inputTokens ?? 0), 0)} tokens、输出 ${results.reduce((sum, result) => sum + (result.usage.outputTokens ?? 0), 0)} tokens（含缓存输入 ${results.reduce((sum, result) => sum + (result.usage.cachedInputTokens ?? 0), 0)}）；没有核实的计价表时费用保持未知，不把缺失用量补估为 0。`
        : '本次离线真实模型请求为 0，真实模型费用为 0。'
    }`,
    `工具调用 ${results.reduce((sum, result) => sum + (result.toolCalls ?? 0), 0)} 次；首个可见正文延迟：${results.map((result) => `${result.sampleId}=${result.firstVisibleTextMs ?? 'null'}`).join('，')}。`,
    `人工介入记录 ${helped} 条；预定固定审批策略的应答与 E09 预定继续提示不计为解题帮助，但逐条保存在结果里。`,
    `runtime=${results[0]?.runtimeHash ?? 'missing'}；corpus=${results[0]?.corpusHash ?? 'missing'}；oracle=${results[0]?.oracleHash ?? 'missing'}；config=${results[0]?.configHash ?? 'missing'}。`,
    '',
    '| 样本 | 结果 | 模型终态 | 独立通过 | 人工帮助 | wall ms | 请求 | 用量完整 | 失败分类 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (result) =>
        `| ${result.sampleId} | ${result.outcome} | ${result.agentStatus ?? '未运行'} | ${result.independentPass} | ${result.humanInterventions.length} | ${result.wallMs} | ${result.requests ?? '未知'} | ${result.usage.complete} | ${String(result.failureClass ?? '').replaceAll('|', '/')} |`,
    ),
    '',
    '本任务集使用实际项目源码中的受控退化/固定需求，已有公开测试和注释可能提示答案；不能称为真实用户总体成功率或外部基准成绩。隐藏评分、原始/退化/参考对照与真实模型结果分别保存。',
    'host模式没有操作系统隔离；外置评分器仅减少误修改，不能对抗恶意shell。未运行UAC/WFP及平台生产隔离验收。缓存off仍不能保证供应商冷缓存。',
    live
      ? '下一步：按失败主题分组，只选择一个产品改动主题另开修复任务，冻结 B 后复用同一 corpus/oracle/prompt 并按 AB/BA/AB 复跑；不在评测批次中修改产品。'
      : '下一步：先解除各项准备阻断，取得用户指定模型/端点/调用和费用授权，验证固定runtime假端点取消/审批路径，再独立试跑E02/E03；全部保留失败和超时，不挑选最好一次。',
    '',
  ].join('\n');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, 'summary.json'),
    JSON.stringify(
      { version: 1, batchId: resolved.batchId, live, summary, timing, helped },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(outputDirectory, 'report.md'), text);
  return { summary, text };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (const argument of process.argv.slice(2)) {
      const match = /^--(input|manifest|out)=(.+)$/.exec(argument);
      if (!match || options[match[1]]) throw new Error('Unknown/duplicate report argument');
      options[match[1]] = path.resolve(match[2]);
    }
    if (!options.input || !options.manifest) throw new Error('--input and --manifest required');
    const report = await writeReport({
      input: options.input,
      manifest: options.manifest,
      outputDirectory: options.out,
    });
    console.log(
      JSON.stringify({
        plannedCount: report.summary.plannedCount,
        complete: report.summary.complete,
        report: path.join(options.out ?? path.dirname(options.input), 'report.md'),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
