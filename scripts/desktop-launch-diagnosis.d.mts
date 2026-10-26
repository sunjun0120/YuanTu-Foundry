/** The launcher's diagnosis, typed for `tests/desktop-launch-diagnosis.test.ts`. */
/** Why Electron exited before opening a window, or undefined when the launcher cannot name it. */
export declare function electronCrashDiagnosis(
  code: number | null,
  executable: string,
  labels: string,
): string | undefined;
