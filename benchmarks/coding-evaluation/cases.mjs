import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { hash } from './materialize.mjs';
import { installWorkload } from './scenario.mjs';

const spill = 'packages/tools/spill.ts';
/**
 * Skips the frozen corpora legitimately declare, per platform.
 *
 * These are tests that cannot run on the platform at all — POSIX permission bits on Windows — and each one states
 * its reason in the TAP output. A skip that is not listed here, or that gives no reason, still fails the check:
 * listing them is what keeps "a disabled assertion" distinguishable from "a test this OS cannot run".
 */
const posixOnlySkip = 'POSIX permission bits are not a Windows concept';
const platformSkips = { win32: [posixOnlySkip] };
const cases = [
  [
    'E01',
    '超长中文/emoji工具输出的磁盘捕获超过约定字节上限，有时末尾出现破损字符；修复并保持输出是原文前缀，保留原有外溢和读取行为。',
    [spill],
    ['tests/spill.test.ts'],
    {
      path: spill,
      before: 'truncateUtf8(input.content, MAX_SPILL_BYTES)',
      after: 'input.content.slice(0, MAX_SPILL_BYTES)',
    },
  ],
  [
    'E02',
    '模型端点返回HTTP 403时，用户看到普通HTTP错误，无法区分鉴权失败；修复分类，保持其他HTTP状态的处理。',
    ['packages/protocol/failure.ts'],
    ['tests/failure-codes.test.ts'],
    {
      path: 'packages/protocol/failure.ts',
      before: "if (status === 401 || status === 403) return 'auth';",
      after: "if (status === 401) return 'auth';",
    },
  ],
  [
    'E03',
    '声明较小上下文而未手工指定输出时，自动输出预算占用过多窗口；恢复预留规则，不改变统一的大窗口默认值。',
    ['packages/providers/automatic-capacity.ts'],
    [
      'tests/automatic-capacity.test.ts',
      'tests/default-capacity.test.ts',
      'tests/model-capacity.test.ts',
    ],
    {
      path: 'packages/providers/automatic-capacity.ts',
      before: 'Math.floor(contextWindow / 4)',
      after: 'Math.floor(contextWindow / 2)',
    },
  ],
  [
    'E04',
    '一次交付同时指定a.txt和./a.txt时出现重复项目；修复同文件检测，保持一次调用全部校验后才声明的语义。',
    ['packages/tools/present.ts'],
    ['tests/present.test.ts'],
    {
      path: 'packages/tools/present.ts',
      // The seed *deletes* the duplicate rejection. The anchor is kept in the pattern because a deletion has no
      // text of its own to find: replacing the anchor-plus-two-lines with the anchor alone removes exactly those
      // two lines, and the reference puts them back. An empty `before` would be the other way to write this and it
      // is not one this harness can express — an empty needle matches everywhere, so `exactReplace` refuses it.
      before:
        '          if (seen.has(evidence.path))\n            throw new Error(`Path "${evidence.path}" is listed more than once`);\n          seen.add(evidence.path);\n',
      after: '          seen.add(evidence.path);\n',
    },
  ],
  [
    'E05',
    '为spillOutput参数对象增加可选retentionLimit，只影响当前会话。省略保持50；只接受整数1–1000，无效值在写入前拒绝。保留8MB字节上限、权限、路径和返回类型。保留顺序为mtimeMs降序，相同时间按文件名Unicode code point降序，不能用localeCompare或sleep。不同session不互删，不增加全局设置。',
    [spill],
    ['tests/spill.test.ts'],
    null,
  ],
  [
    'E06',
    '为CLI run与resume增加--prompt-file <path>。支持长中文、相对调用方cwd、空格/单引号路径、严格UTF-8和可选BOM，非空，原始最多65536字节。run无需位置提示，resume仍需session ID；混用位置提示或其他命令使用此选项均拒绝。无效输入在模型请求前失败；原有命令、模型和密钥选择保持可用，帮助与语法一致。',
    ['apps/shared/args.ts', 'apps/cli/main.ts'],
    ['tests/cli.test.ts'],
    null,
  ],
  [
    'E07',
    '将UTF-8截断与外溢文件名生成抽到packages/tools/spill-format.ts，导出truncateUtf8(content:string,maxBytes:number):string与spillName(tool:string):string。保留原模块所有公开导出、签名、返回值、权限、路径、8MB上限和每会话默认保留数量。新模块仅负责这两个格式函数，不承担磁盘I/O。',
    [spill, 'packages/tools/spill-format.ts'],
    ['tests/spill.test.ts'],
    null,
  ],
  [
    'E08',
    '用户在大仓库搜索时找不到某些文件内容。只读调查内置文件搜索与知识检索的范围，给出限制、触发条件、源码证据和至少一个可复现办法。不得修改产品。输出evaluation-analysis.json，格式为{findings:[{claim,path,startLine,endLine,excerpt,reproduction}],recommendations:[string]}，至少4条不同发现。',
    ['evaluation-analysis.json'],
    [],
    null,
  ],
  [
    'E09',
    '先运行公开evaluation-workload.cjs命令，返回后完成spillOutput可选保留数量需求。省略保持50；1–1000整数，写入前拒绝无效值。相同mtime按Unicode code point降序保留。',
    [spill],
    ['tests/spill.test.ts'],
    null,
  ],
  [
    'E10',
    '将两个独立主题分别交给两个可写子代理，固定模型与父模型一致并发2，限定各自拥有文件：一个完成spillOutput可选retentionLimit需求，另一个实现CLI --prompt-file需求。父agent收集报告、处理集成问题、执行相关验证并给出结果。',
    [spill, 'apps/shared/args.ts', 'apps/cli/main.ts'],
    ['tests/spill.test.ts', 'tests/cli.test.ts'],
    null,
  ],
].map(([id, prompt, allowedPaths, publicCheck, seed]) => ({
  id,
  category: Number(id.slice(1)) <= 8 ? 'coding' : 'operational',
  prompt,
  timeoutMs: ['E01', 'E02', 'E03', 'E04', 'E08'].includes(id) ? 300_000 : 600_000,
  allowedPaths,
  publicCheck,
  seed,
  oracle: `oracle/${id}.mjs`,
  reference: `reference:${id}:v1`,
  platformSkips,
  /**
   * E06 and E10 carry `tests/cli.test.ts` as their frozen old regression, and that whole file is paused upstream:
   * every case in it is a literal `test.skip` with the comment that the bodies are retained for restoration. So
   * "the file ran and asserted nothing" is the input's real, verifiable state rather than a candidate deleting
   * assertions — the report says so explicitly instead of either inventing a red result or calling it green.
   *
   * A case listed here still fails if any test in the file executes and fails: the exemption only widens what
   * "paused" covers, it does not stop the file from being run.
   */
  ...(['E06', 'E10'].includes(id) ? { publicCheckFullyPaused: true } : {}),
  /**
   * E06 and E10 are *not* blocked here on purpose: the harness can sample them through the Agent Host, and the
   * product-level obstacle is part of the result. `PRODUCT_SCOPE.cli` is false, so a task whose requirement is a
   * CLI flag is expected to fail rather than to be skipped — a `blocked` row would hide a real product limitation
   * behind a harness refusal, which is exactly what the report is supposed to distinguish.
   */
}));
export function getCase(id) {
  const definition = cases.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown fixed case: ${id}`);
  return structuredClone(definition);
}
export const CASE_IDS = cases.map((entry) => entry.id);
export async function exactReplace(directory, relative, before, after) {
  const file = path.join(directory, relative);
  const original = await readFile(file, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const needle = before.replaceAll('\n', newline);
  /**
   * An empty pattern matches at every position, so `split('').length` is the file length plus one and the
   * one-exact-occurrence rule below could never be satisfied. Refusing it here keeps the failure legible: a seed
   * that means "delete this" has to carry enough surrounding text to be a pattern.
   */
  if (!needle)
    throw new Error(`Seed/reference drift: empty pattern in ${relative} cannot be a unique anchor`);
  if (original.split(needle).length !== 2)
    throw new Error(`Seed/reference drift: expected one exact occurrence in ${relative}`);
  const result = original.replace(needle, after.replaceAll('\n', newline));
  await writeFile(file, result);
  return { path: relative, before, after, beforeSha256: hash(original), afterSha256: hash(result) };
}
export async function prepareCase(caseDef, workspace) {
  if (caseDef.blockedReason) throw new Error(caseDef.blockedReason);
  if (caseDef.id === 'E09') workspace.scenario = await installWorkload(workspace);
  const seed = caseDef.seed
    ? await exactReplace(
        workspace.directory,
        caseDef.seed.path,
        caseDef.seed.before,
        caseDef.seed.after,
      )
    : null;
  return {
    workspace,
    prompt: caseDef.prompt,
    promptHash: hash(caseDef.prompt),
    seedHash: seed ? hash(seed) : null,
    seed,
    allowedPaths: caseDef.allowedPaths,
  };
}
export async function casePreparationBlock(caseDef, frozen) {
  if (caseDef.blockedReason) return caseDef.blockedReason;
  if (['E06', 'E10'].includes(caseDef.id)) {
    const scope = await readFile(
      path.join(frozen.corpusDirectory, 'packages/protocol/product-scope.ts'),
      'utf8',
    ).catch(() => null);
    if (!scope)
      return `${caseDef.id} frozen product scope unavailable; CLI capability cannot be certified`;
    if (/\bcli\s*:\s*false\b/.test(scope))
      return `${caseDef.id} product requirement blocked: PRODUCT_SCOPE.cli=false; retained parser checks cannot certify the paused CLI command`;
  }
  /**
   * E08's rubric is versioned against the frozen corpus, so the only preparation check left is that the facts it
   * scores still exist there. The oracle re-reads them itself; this refuses the batch before any paid sample when
   * the corpus drifted underneath the rubric.
   */
  if (caseDef.id === 'E08') {
    const facts = [
      ['packages/tools/files.ts', /maximum: MAX_LIST_FILES_LIMIT/],
      ['packages/search/inventory.ts', /export const LEGACY_MAX_ENTRIES = 5_000;/],
      ['packages/search/inventory.ts', /export const LEGACY_MAX_FILES = 1_000;/],
      ['packages/search/inventory.ts', /export const SEARCH_MAX_ENTRIES = 200_000;/],
      ['packages/tools/files.ts', /const REGEX_MAX_FILES = 10_000;/],
      ['packages/tools/files.ts', /async read\(input: string, limit = 256_000/],
      ['packages/search/text.ts', /export const MAX_MATCH_TEXT = 500;/],
      [
        'packages/knowledge/store.ts',
        /if \(count >= 64\) throw new Error\('Document limit reached \(64\)'\);/,
      ],
      ['packages/knowledge/store.ts', /limit < 1 \|\| limit > 20\)/],
    ];
    for (const [relative, pattern] of facts) {
      let content;
      try {
        content = await readFile(path.join(frozen.corpusDirectory, relative), 'utf8');
      } catch {
        return `E08 rubric drift: ${relative} is missing from the frozen corpus`;
      }
      if (!pattern.test(content))
        return `E08 rubric drift: ${relative} no longer contains the limit this rubric scores; version a replacement rubric before scoring`;
    }
  }
  return null;
}
const truncateFunction = `function truncateUtf8(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= maxBytes) return content;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}`;
const nameFunction = `function spillName(tool: string): string {
  const safe = tool.replace(/[^a-z0-9_-]+/gi, '-').slice(0, MAX_TOOL_NAME_CHARS) || 'tool';
  return \`\${safe}-\${Date.now().toString(36)}-\${randomUUID().slice(0, 8)}.txt\`;
}`;
/**
 * E05's reference: an optional, validated retention limit that only ever affects the current session.
 *
 * The ordering rule is the part a candidate is most likely to get subtly wrong, so the reference states it
 * literally: newest `mtimeMs` first, ties broken by file name in Unicode code-point order (never `localeCompare`,
 * which would make the outcome depend on the machine's collation).
 */
async function applySpillRetentionReference(workspace) {
  const records = [];
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      'export function spillOutput(input: {\n  workspace: string;\n  sessionId: string;\n  tool: string;\n  content: string;\n}): SpilledOutput | null {\n  const directory',
      'export function spillOutput(input: {\n  workspace: string;\n  sessionId: string;\n  tool: string;\n  content: string;\n  retentionLimit?: number;\n}): SpilledOutput | null {\n  const retentionLimit = input.retentionLimit === undefined ? MAX_SPILL_FILES_PER_SESSION : input.retentionLimit;\n  if (!Number.isInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > 1000)\n    throw new Error("retentionLimit must be an integer from 1 to 1000");\n  const directory',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      '  trimSpills(directory);\n  return {',
      '  trimSpills(directory, retentionLimit);\n  return {',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      'function trimSpills(directory: string): void {',
      'function trimSpills(directory: string, retentionLimit = MAX_SPILL_FILES_PER_SESSION): void {\n  trimLimits.set(directory, retentionLimit);',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      'const trimAgain = new Set<string>();',
      'const trimAgain = new Set<string>();\nconst trimLimits = new Map<string, number>();',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      '  })().finally(() => trimming.delete(directory));',
      '  })().finally(() => {\n    trimming.delete(directory);\n    trimLimits.delete(directory);\n  });',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      '    files.sort((a, b) => b.at - a.at);',
      '    files.sort((a, b) => b.at - a.at || compareCodePoints(b.name, a.name));',
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      spill,
      'files.slice(MAX_SPILL_FILES_PER_SESSION)',
      'files.slice(trimLimits.get(directory) ?? MAX_SPILL_FILES_PER_SESSION)',
    ),
  );
  await writeFile(
    path.join(workspace.directory, spill),
    (await readFile(path.join(workspace.directory, spill), 'utf8')) +
      `\nfunction compareCodePoints(a: string, b: string): number {\n  const left = Array.from(a), right = Array.from(b);\n  for (let i = 0; i < Math.min(left.length, right.length); i++) {\n    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;\n    if (difference) return difference;\n  }\n  return left.length - right.length;\n}\n`,
  );
  return records;
}
/**
 * E06's reference: `--prompt-file` for `run` and `resume` only, validated before any model request.
 *
 * The reference deliberately stops at "the option is parsed and its input is validated": the CLI entry point is
 * behind `PRODUCT_SCOPE.cli`, so a reference that also ran the command could not be exercised in this product.
 * The oracle asserts the same boundary.
 */
async function applyPromptFileReference(workspace) {
  const records = [];
  records.push(
    await exactReplace(
      workspace.directory,
      'apps/shared/args.ts',
      '  /** Path to a JSON completion contract, read and normalized before any model request is made. */\n  completionSpec?: string;',
      "  /** Path to a JSON completion contract, read and normalized before any model request is made. */\n  completionSpec?: string;\n  /** A prompt read from a file, for `run` and `resume` only. Relative paths resolve against the caller's cwd. */\n  promptFile?: string;",
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      'apps/shared/args.ts',
      "    '--completion-spec': 'completionSpec',",
      "    '--completion-spec': 'completionSpec',\n    '--prompt-file': 'promptFile',",
    ),
  );
  records.push(
    await exactReplace(
      workspace.directory,
      'apps/shared/args.ts',
      "import { ENVIRONMENT } from '../../packages/protocol/settings.ts';",
      "import { readFileSync } from 'node:fs';\nimport { ENVIRONMENT } from '../../packages/protocol/settings.ts';\n\n/** The raw byte ceiling for `--prompt-file`, before any decoding. */\nexport const MAX_PROMPT_FILE_BYTES = 65_536;\n/**\n * Read the prompt `--prompt-file` names, or explain why it cannot be used.\n *\n * Decoding is strict: a byte sequence that is not UTF-8 is refused rather than replaced with U+FFFD, because a\n * prompt silently repaired into replacement characters is a prompt nobody wrote. One leading BOM is tolerated and\n * stripped. Every failure here happens before a provider is constructed.\n */\nexport function readPromptFile(file: string, cwd = process.cwd()): string {\n  const resolved = require_absolute(file, cwd);\n  const bytes = readFileSync(resolved);\n  if (bytes.length > MAX_PROMPT_FILE_BYTES)\n    throw new Error(`--prompt-file exceeds ${MAX_PROMPT_FILE_BYTES} bytes`);\n  let text;\n  try {\n    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);\n  } catch {\n    throw new Error('--prompt-file must be valid UTF-8');\n  }\n  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);\n  if (!text.trim()) throw new Error('--prompt-file must not be empty');\n  return text;\n}\nfunction require_absolute(file: string, cwd: string): string {\n  return file.startsWith('/') || /^[a-zA-Z]:[\\\\/]/.test(file) ? file : `${cwd}/${file}`;\n}",
    ),
  );
  return records;
}
/**
 * E08's reference report. Every finding is generated from the frozen source itself — path, line range, excerpt and
 * reproduction — so the reference cannot claim a fact the corpus does not contain.
 */
async function applyAnalysisReportReference(workspace) {
  const facts = [
    [
      'packages/tools/files.ts',
      'maximum: MAX_LIST_FILES_LIMIT',
      'file 列举每页上限为 1000：list_files 的 limit 参数被 clamp 到 MAX_LIST_FILES_LIMIT=1000，超出部分必须靠 cursor 翻页',
      'list_files 传入 limit=5000 只会返回 1000 条，并带 retrieval-metadata 说明被截断；用上一次结果的 nextCursor 继续取下一页',
    ],
    [
      'packages/search/inventory.ts',
      'export const LEGACY_MAX_ENTRIES = 5_000;',
      '目录遍历的条目预算默认为 5000：walk 走的是 LEGACY_MAX_ENTRIES，超过后停止枚举',
      '在一个含 6000 个文件的目录中调用 list_files，观察 coverage 报告为 entry-limit 而不是完整清单',
    ],
    [
      'packages/search/inventory.ts',
      'export const LEGACY_MAX_FILES = 1_000;',
      '单次列举的文件数默认上限为 1000：LEGACY_MAX_FILES 是 walk 返回文件数组的截断点',
      '同一目录下 list_files 只返回 1000 条路径，其余文件虽然存在但不在结果里',
    ],
    [
      'packages/search/inventory.ts',
      'export const SEARCH_MAX_ENTRIES = 200_000;',
      '文本搜索使用更大的条目预算 200000：search 走 SEARCH_MAX_ENTRIES，因此搜索结果通常不是被条目预算截断的',
      '对同一目录执行 search_files，coverage 报告与 list_files 的 entry-limit 不同，说明两者预算不同',
    ],
    [
      'packages/tools/files.ts',
      'const REGEX_MAX_FILES = 10_000;',
      '正则模式搜索最多扫描 10000 个文件：超出部分不会进入扫描，结果标记 file-limit',
      '在超过 10000 个文件的仓库里用 regex 模式搜索一个只存在于第 10001 个文件的字符串，结果为空且 limited=true',
    ],
    [
      'packages/tools/files.ts',
      'async read(input: string, limit = 256_000',
      'Workspace.read 默认只读取前 256000 字节：读取接口本身是前缀读，超过部分需要显式分页',
      '对一个大于 256000 字节的文件调用读取接口，返回值末尾带 [file truncated]，且长度停在 256000 字节附近',
    ],
    [
      'packages/search/text.ts',
      'export const MAX_MATCH_TEXT = 500;',
      '匹配行文本被截断到 500 字符：MAX_MATCH_TEXT 决定每行返回多少内容',
      '对一条 2000 字符的长行搜索并命中，返回的匹配文本长度为 500 并带截断标记',
    ],
    [
      'packages/knowledge/store.ts',
      "if (count >= 64) throw new Error('Document limit reached (64)');",
      '每个工作区最多固定 64 篇知识库文档：超出后 pinDocument 直接抛错',
      '连续 pin 65 个文档，第 65 个抛出 Document limit reached (64)',
    ],
    [
      'packages/knowledge/store.ts',
      'limit < 1 || limit > 20)',
      '知识库全文检索结果上限为 20：search 校验 limit 范围 1–20，默认 8',
      '调用知识库检索并传入 limit=50，观察到参数被拒绝而不是返回 50 条',
    ],
  ];
  const findings = [];
  for (const [relative, needle, claim, reproduction] of facts) {
    const lines = (await readFile(path.join(workspace.directory, relative), 'utf8')).split('\n');
    const index = lines.findIndex((text) => text.includes(needle));
    if (index < 0) throw new Error(`E08 reference drift: ${relative} lost "${needle}"`);
    findings.push({
      claim,
      path: relative,
      startLine: index + 1,
      endLine: index + 1,
      excerpt: lines[index].trim(),
      reproduction,
    });
  }
  const report = {
    findings,
    recommendations: [
      '在列举结果里始终读取 coverage/retrieval-metadata，并说明结果是完整还是被 entry/file 预算截断',
      '需要在超大仓库定位内容时优先用文本搜索（条目预算 200000），把 list_files 当作导航而不是清单',
      '需要读取超过 256000 字节的文件时按行范围分页读取，而不是假设一次读全',
      '知识库固定文档数上限为 64，需要更大范围检索时应改用工作区文本搜索',
    ],
  };
  await writeFile(
    path.join(workspace.directory, 'evaluation-analysis.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' },
  );
  return [{ path: 'evaluation-analysis.json', findings: findings.length }];
}
export async function applyReference(caseDef, workspace) {
  const records = [];
  if (caseDef.seed)
    records.push(
      await exactReplace(
        workspace.directory,
        caseDef.seed.path,
        caseDef.seed.after,
        caseDef.seed.before,
      ),
    );
  else if (caseDef.id === 'E05') {
    records.push(...(await applySpillRetentionReference(workspace)));
  } else if (caseDef.id === 'E07') {
    records.push(await exactReplace(workspace.directory, spill, truncateFunction, ''));
    records.push(await exactReplace(workspace.directory, spill, nameFunction, ''));
    records.push(
      await exactReplace(
        workspace.directory,
        spill,
        "import { createHash, randomUUID } from 'node:crypto';",
        "import { createHash } from 'node:crypto';\nimport { truncateUtf8, spillName } from './spill-format.ts';",
      ),
    );
    records.push(
      await exactReplace(workspace.directory, spill, 'const MAX_TOOL_NAME_CHARS = 40;', ''),
    );
    await writeFile(
      path.join(workspace.directory, 'packages/tools/spill-format.ts'),
      `import { randomUUID } from 'node:crypto';\nconst MAX_TOOL_NAME_CHARS = 40;\nexport ${truncateFunction}\nexport ${nameFunction}\n`,
      { flag: 'wx' },
    );
  } else if (caseDef.id === 'E09') {
    records.push(...(await applySpillRetentionReference(workspace)));
  } else if (caseDef.id === 'E06') {
    records.push(...(await applyPromptFileReference(workspace)));
  } else if (caseDef.id === 'E08') {
    records.push(...(await applyAnalysisReportReference(workspace)));
  } else if (caseDef.id === 'E10') {
    // E10 is the integration of E05 and E06: the reference is both references, applied to one workspace.
    records.push(...(await applySpillRetentionReference(workspace)));
    records.push(...(await applyPromptFileReference(workspace)));
  } else throw new Error(`Reference for ${caseDef.id} is not certified; preparation is blocked`);
  return { records, hash: hash(records) };
}
