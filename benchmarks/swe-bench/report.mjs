import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { distribution } from '../coding-evaluation/metrics.mjs';
import { canonical, readDataset } from './select-subset.mjs';
import { namedArguments } from './ingest.mjs';

export function wilson(successes, total) {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > total
  )
    throw new Error('Invalid binomial counts');
  if (!total) return null;
  const z = 1.959963984540054,
    p = successes / total,
    d = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / d,
    margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === total ? 1 : Math.min(1, center + margin),
  };
}
export function exactMcNemar(b, c) {
  if (![b, c].every((n) => Number.isSafeInteger(n) && n >= 0) || b + c > 1000)
    throw new Error('Invalid discordant counts');
  const n = b + c;
  if (!n) return 1;
  let term = 2 ** -n,
    sum = term;
  for (let i = 1; i <= Math.min(b, c); i++) {
    term *= (n - i + 1) / i;
    sum += term;
  }
  return Math.min(1, 2 * sum);
}
function assertInstances(rows, manifest) {
  const ids = manifest.instances;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    rows.length !== ids.length ||
    new Set(rows.map((r) => r.instanceId)).size !== ids.length ||
    rows.some((r) => !ids.includes(r.instanceId) || r.configHash !== manifest.configHash)
  )
    throw new Error('Batch instance or config mismatch');
  for (const row of rows)
    if (row.evaluation && !['resolved', 'unresolved', 'error'].includes(row.evaluation.status))
      throw new Error('Unknown official verdict');
}
export function summarize(rows, manifest) {
  assertInstances(rows, manifest);
  const resolved = rows.filter((r) => r.evaluation?.status === 'resolved').length;
  const unresolved = rows.filter((r) => r.evaluation?.status === 'unresolved').length;
  const error = rows.filter((r) => r.evaluation?.status === 'error').length;
  const pending = rows.length - resolved - unresolved - error;
  const known = (key) =>
    rows.map((r) => r.tokens?.[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const sampleTokens = distribution(
    rows
      .filter(
        (r) =>
          typeof r.tokens?.inputTokens === 'number' && typeof r.tokens?.outputTokens === 'number',
      )
      .map((r) => r.tokens.inputTokens + r.tokens.outputTokens),
  );
  return {
    version: 1,
    total: rows.length,
    live: rows.every((r) => r.live === true),
    resolved,
    unresolved,
    error,
    pending,
    graded: resolved + unresolved,
    complete: pending === 0,
    passRate: pending === rows.length ? null : resolved / rows.length,
    wilson95: pending === rows.length ? null : wilson(resolved, rows.length),
    emptyPatches: rows.filter((r) => r.patch?.bytes === 0 || r.failureClass === 'empty-patch')
      .length,
    changedTests: rows.filter((r) => r.patch?.changedTests).length,
    generationErrors: rows.filter((r) => r.status === 'invalid').length,
    rounds: distribution(rows.map((r) => r.rounds)),
    durationMs: distribution(rows.map((r) => r.durationMs)),
    inputTokens: distribution(known('inputTokens')),
    outputTokens: distribution(known('outputTokens')),
    cachedInputTokens: distribution(known('cachedInputTokens')),
    tokenTotals: {
      inputTokens: known('inputTokens').reduce((a, b) => a + b, 0),
      outputTokens: known('outputTokens').reduce((a, b) => a + b, 0),
      cachedInputTokens: known('cachedInputTokens').reduce((a, b) => a + b, 0),
      complete: rows.every((r) => r.tokens?.complete === true),
    },
    configHash: manifest.configHash,
    suggestedMaxKnownTokensPerSample:
      sampleTokens.median === null ? null : Math.ceil(3 * sampleTokens.median),
    runtime: [...new Set(rows.map((r) => r.runtime))],
  };
}
export function compareBatches(a, b) {
  assertInstances(a.rows, a.manifest);
  assertInstances(b.rows, b.manifest);
  if (
    a.manifest.configHash !== b.manifest.configHash ||
    JSON.stringify(canonical(a.manifest.comparison)) !==
      JSON.stringify(canonical(b.manifest.comparison))
  )
    throw new Error('Incompatible comparison configuration');
  if (a.rows.some((r) => !r.evaluation) || b.rows.some((r) => !r.evaluation))
    throw new Error('Paired comparison requires official evaluation for every instance');
  const table = { bothResolved: 0, onlyA: 0, onlyB: 0, neitherResolved: 0 };
  for (const row of a.rows) {
    const ar = row.evaluation.status === 'resolved',
      br = b.rows.find((r) => r.instanceId === row.instanceId).evaluation.status === 'resolved';
    table[ar ? (br ? 'bothResolved' : 'onlyA') : br ? 'onlyB' : 'neitherResolved']++;
  }
  const discordantGraded = a.rows.filter((row) => {
    const other = b.rows.find((r) => r.instanceId === row.instanceId);
    return row.evaluation.status !== 'error' && other.evaluation.status !== 'error';
  });
  return {
    total: a.rows.length,
    table,
    pValue: exactMcNemar(table.onlyA, table.onlyB),
    errorPairs: a.rows.length - discordantGraded.length,
    note: 'error 保留在分母与未通过配对中；错误不是模型失败，环境原因可能影响配对检验。n=50 下差异小于约 10 个百分点通常不显著。',
  };
}
export async function loadBatch(directory) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'manifest.resolved.json'), 'utf8'),
  );
  let rows;
  try {
    rows = await readDataset(path.join(directory, 'results.evaluated.jsonl'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    rows = await readDataset(path.join(directory, 'results.jsonl'));
  }
  return { manifest, rows, directory };
}
const percent = (value) => (value === null ? '未验收' : `${(100 * value).toFixed(1)}%`);
export async function writeReport({
  batchDirectory,
  otherDirectory,
  outputDirectory = batchDirectory,
}) {
  const a = await loadBatch(batchDirectory),
    summary = summarize(a.rows, a.manifest);
  const b = otherDirectory ? await loadBatch(otherDirectory) : null;
  const comparison = b ? compareBatches(a, b) : null;
  const otherSummary = b ? summarize(b.rows, b.manifest) : null;
  const text = [
    '# SWE-bench Verified 子集评测',
    '',
    `批次：${a.manifest.batchId ?? path.basename(batchDirectory)}。真实模型批次：${summary.live ? '是' : '否（离线或假端点，不是模型成绩）'}。`,
    '',
    '| 指标 | A |' + (b ? ' B |' : ''),
    '| --- | --- |' + (b ? ' --- |' : ''),
  ];
  for (const [label, key] of [
    ['计划题数', 'total'],
    ['resolved', 'resolved'],
    ['unresolved', 'unresolved'],
    ['error（含未判定）', 'error'],
    ['待验收', 'pending'],
    ['实际判定 resolved + unresolved', 'graded'],
    ['空补丁', 'emptyPatches'],
    ['修改测试文件', 'changedTests'],
  ])
    text.push(`| ${label} | ${summary[key]} |${b ? ` ${otherSummary[key]} |` : ''}`);
  text.push(
    `| 通过率（全部计划题为分母） | ${percent(summary.passRate)} |${b ? ` ${percent(otherSummary.passRate)} |` : ''}`,
    `| Wilson 95% 区间 | ${summary.wilson95 ? `${percent(summary.wilson95.lower)}–${percent(summary.wilson95.upper)}` : '未验收'} |${b ? ` ${otherSummary.wilson95 ? `${percent(otherSummary.wilson95.lower)}–${percent(otherSummary.wilson95.upper)}` : '未验收'} |` : ''}`,
    '',
    '| 分布 | A 中位数 / 最小 / 最大 |' + (b ? ' B 中位数 / 最小 / 最大 |' : ''),
    '| --- | --- |' + (b ? ' --- |' : ''),
  );
  const dist = (value) =>
    `${value.median ?? '未知'} / ${value.min ?? '未知'} / ${value.max ?? '未知'}`;
  for (const key of ['rounds', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'durationMs'])
    text.push(`| ${key} | ${dist(summary[key])} |${b ? ` ${dist(otherSummary[key])} |` : ''}`);
  if (comparison)
    text.push(
      '',
      '| 配对 | B 通过 | B 未通过（含 error） |',
      '| --- | --- | --- |',
      `| A 通过 | ${comparison.table.bothResolved} | ${comparison.table.onlyA} |`,
      `| A 未通过（含 error） | ${comparison.table.onlyB} | ${comparison.table.neitherResolved} |`,
      '',
      `精确 McNemar p = ${comparison.pValue}；含 error 的配对为 ${comparison.errorPairs}。${comparison.note}`,
    );
  text.push(
    '',
    '## 逐题追溯',
    '',
    '| instance | A 结论 | A 证据 |' + (b ? ' B 结论 | B 证据 |' : ''),
    '| --- | --- | --- |' + (b ? ' --- | --- |' : ''),
  );
  const evidence = (r) =>
    r.evaluation?.report
      ? `\`${r.evaluation.report}\`（sha256 ${r.evaluation.reportSha256}）`
      : (r.evaluation?.reason ?? r.failureClass ?? '待验收');
  for (const row of [...a.rows].sort((x, y) => x.instanceId.localeCompare(y.instanceId))) {
    const other = b?.rows.find((r) => r.instanceId === row.instanceId);
    text.push(
      `| ${row.instanceId} | ${row.evaluation?.status ?? 'pending'} | ${evidence(row)} |${other ? ` ${other.evaluation?.status ?? 'pending'} | ${evidence(other)} |` : ''}`,
    );
  }
  text.push(
    '',
    '## 边界与成本',
    '',
    '- 生成模式为 no-commands，Agent 不能运行测试；数字只用于版本间对比，不与能执行代码的排行榜 Agent 直接比较。',
    '- 固定 50 题子集（冒烟仅 5 题），每版本一次，没有重复采样，结论粒度粗。工装完成、真实任务结果、与排行榜可比是三件事，各自需要证据。',
    '- 官方 error 表示未得到有效判定，保留在总分母，单独列出原因；不能直接归因为模型失败。空补丁也未被官方判定，并单列数量。',
    '- 不同模型、promptCache、子集、提示模板或生成配置的结果拒绝比较。轮数来自已结束步骤，token 完整性以保存的 usage 标志为准；未知不当成已知零。',
    '- 费用公式：单题费用 = 输入 token × 输入单价 + 输出 token × 输出单价，缓存部分按缓存单价；全量两版本费用 = 冒烟平均单题费用 × 50 × 2。单价未提供时只报告 token，不推算金额。',
    `- A 已知 token 合计：输入 ${summary.tokenTotals.inputTokens}、输出 ${summary.tokenTotals.outputTokens}、缓存输入 ${summary.tokenTotals.cachedInputTokens}；完整：${summary.tokenTotals.complete}。`,
    '- 请求数与 token 阈值是观察后取消，不是硬费用上限。完整性不明的 token 不能用来承诺费用上界。',
    '',
  );
  await mkdir(outputDirectory, { recursive: true });
  text.push(
    `观察阈值建议（每题已知输入与输出 token 中位数的 3 倍）：A ${summary.suggestedMaxKnownTokensPerSample ?? '未知'}${otherSummary ? `，B ${otherSummary.suggestedMaxKnownTokensPerSample ?? '未知'}` : ''}；该建议不是费用硬上限。`,
    '',
  );
  if (otherSummary)
    text.push(
      `B 已知 token 合计：输入 ${otherSummary.tokenTotals.inputTokens}、输出 ${otherSummary.tokenTotals.outputTokens}、缓存输入 ${otherSummary.tokenTotals.cachedInputTokens}；完整：${otherSummary.tokenTotals.complete}。`,
      '',
    );
  await writeFile(
    path.join(outputDirectory, 'summary.json'),
    JSON.stringify(
      { ...summary, ...(comparison ? { other: otherSummary, comparison } : {}) },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(outputDirectory, 'report.md'), text.join('\n'));
  return { summary, comparison };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = namedArguments(process.argv.slice(2), ['batch'], ['compare', 'out']);
    await writeReport({
      batchDirectory: path.resolve(args.batch),
      otherDirectory: args.compare ? path.resolve(args.compare) : undefined,
      outputDirectory: path.resolve(args.out ?? args.batch),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
