/**
 * Why `native` cannot be selected on this platform, or `false` where it has a backend.
 *
 * `native` means Windows or Seatbelt and never falls back to the host, so on Linux selecting it throws by design
 * (`nativeSandboxBackend`). Tests that exercise a native selection skip with this reason there; tests that loop
 * over every backend leave `native` out with `nativeModes`.
 */
export const nativeSkip: string | false =
  process.platform === 'win32' || process.platform === 'darwin'
    ? false
    : `native sandbox has no backend on ${process.platform}`;

/** `['native']` where the platform has a native backend, otherwise empty. */
export const nativeModes: readonly 'native'[] = nativeSkip ? [] : ['native'];
