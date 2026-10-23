import type { TestRecord } from './test-report-merge.mjs';

export function lastReportedCase(
  timings: string,
  byteLimit: number,
): Promise<(TestRecord & { kind: 'case'; name: string }) | undefined>;
