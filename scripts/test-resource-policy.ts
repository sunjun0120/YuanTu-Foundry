import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const TEST_RESOURCES = [
  'windows-sandbox',
  'machine-lease',
  'real-pty',
  'desktop-ui',
  'os-credentials',
] as const;
export type TestResource = (typeof TEST_RESOURCES)[number];

export interface PartitionOptions {
  root: string;
}
export interface TestPartition {
  parallel: string[];
  serial: string[];
  reasons: Record<string, string>;
  resources: Record<string, TestResource[]>;
}

export function serialResources(
  source: string,
  file: string,
): { resource: TestResource; reason: string }[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const result: { resource: TestResource; reason: string }[] = [];
  let code = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.MultiLineCommentTrivia &&
      scanner.getTokenText().includes('@test-serial')
    )
      throw new Error(`Invalid test resource declaration in ${file}: use a header line comment`);
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
      const comment = scanner.getTokenText();
      if (!comment.includes('@test-serial')) continue;
      const match = /^\/\/\s*@test-serial\s+([a-z-]+):\s*(\S.*)$/.exec(comment);
      if (
        code ||
        !match ||
        !TEST_RESOURCES.includes(match[1] as TestResource) ||
        result.some((item) => item.resource === match[1])
      )
        throw new Error(`Invalid test resource declaration in ${file}`);
      result.push({ resource: match[1] as TestResource, reason: match[2]! });
    } else if (
      ![
        ts.SyntaxKind.WhitespaceTrivia,
        ts.SyntaxKind.NewLineTrivia,
        ts.SyntaxKind.MultiLineCommentTrivia,
        ts.SyntaxKind.ShebangTrivia,
      ].includes(token)
    )
      code = true;
  }
  return result;
}

export function testResources(source: string, file: string): TestResource[] {
  return serialResources(source, file).map((item) => item.resource);
}

export async function partitionIsolatedTests(
  files: string[],
  options: PartitionOptions,
): Promise<TestPartition> {
  const parallel: string[] = [],
    serial: string[] = [];
  const reasons: Record<string, string> = {},
    resources: Record<string, TestResource[]> = {};
  for (const file of new Set(
    files.map((item) => item.replaceAll('\\', '/').replace(/^\.\//, '')),
  )) {
    const items = serialResources(await readFile(path.resolve(options.root, file), 'utf8'), file);
    resources[file] = items.map((item) => item.resource);
    (items.length ? serial : parallel).push(file);
    reasons[file] = items.length
      ? items.map((item) => `${item.resource}: ${item.reason}`).join('; ')
      : 'isolated process, private temporary and state directories';
  }
  return { parallel: parallel.sort(), serial: serial.sort(), reasons, resources };
}
