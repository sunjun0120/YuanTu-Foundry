/** Explicit compatibility scope; excluded from default discovery, runnable by the legacy acceptance command. */
export const WINDOWS_LEGACY_ACCEPTANCE_FILES = [
  'tests/sandbox-windows.test.ts',
  'tests/sandbox-windows-assets.test.ts',
  'tests/sandbox-windows-recovery.test.ts',
];

/** Main Windows journeys must execute through initialized sandbox accounts without skips. */
export const WINDOWS_ACCOUNT_JOURNEY_FILES = [
  'tests/host-program-process.test.ts',
  'tests/native-git-native.test.ts',
  'tests/program-process-native.test.ts',
  'tests/restricted-consumers-native.test.ts',
  'tests/tools-native.test.ts',
  'tests/windows-sandbox-host.test.ts',
];
