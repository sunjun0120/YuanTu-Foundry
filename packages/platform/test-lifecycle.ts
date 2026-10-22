/** Installed only by the isolated test preload; ordinary product execution has no hook. */
interface TestLifecycle {
  require(resource: 'real-pty' | 'windows-sandbox'): void;
  track(pid: number, started: number): () => void;
  /** This test file's own Windows sandbox lease and journal directory. */
  windowsSandboxState?: string;
}
function hook(): TestLifecycle | undefined {
  return (globalThis as typeof globalThis & { [key: symbol]: TestLifecycle | undefined })[
    Symbol.for('yuantu.test-lifecycle')
  ];
}
export function testResource(resource: 'real-pty' | 'windows-sandbox'): TestLifecycle | undefined {
  const lifecycle = hook();
  lifecycle?.require(resource);
  return lifecycle;
}
/** The per-file state directory a test run substitutes for the account's; undefined outside tests. */
export function testWindowsSandboxStateDirectory(): string | undefined {
  return hook()?.windowsSandboxState;
}
