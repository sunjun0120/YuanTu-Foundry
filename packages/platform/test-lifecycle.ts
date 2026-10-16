/** Installed only by the isolated test preload; ordinary product execution has no hook. */
interface TestLifecycle {
  require(resource: 'real-pty' | 'windows-sandbox'): void;
  track(pid: number, started: number): () => void;
}
export function testResource(resource: 'real-pty' | 'windows-sandbox'): TestLifecycle | undefined {
  const hook = (globalThis as typeof globalThis & { [key: symbol]: TestLifecycle | undefined })[
    Symbol.for('yuantu.test-lifecycle')
  ];
  hook?.require(resource);
  return hook;
}
