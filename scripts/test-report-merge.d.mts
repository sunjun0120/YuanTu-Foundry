export interface TestRecord {
  kind: string;
  file?: string | null;
  counts?: Record<string, number>;
  [key: string]: unknown;
}
export function readFileReport(
  target: string,
  file: string,
  root: string,
): Promise<{
  problem?: string;
  records: TestRecord[];
  summary?: TestRecord;
  fileSummary?: TestRecord;
  zeroTestFiles?: number;
}>;
