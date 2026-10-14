/**
 * Validate identity metadata only. A libuv version does not prove AppContainer
 * compatibility (including builds with backported upstream #5181 fixes).
 * Public execution requires the actual provider's child stdio and network probe.
 */
export function appContainerRuntimeError(uv: string | undefined): string | null {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(uv ?? '');
  if (parts && parts[0] === uv) return null;
  return `Invalid libuv runtime identity: ${uv ?? 'unknown'}. Inspect the actual bundled Node runtime.`;
}

/** Run inside the container; all three stdio channels must actually work. */
export const APPCONTAINER_CHILD_STDIO_PROBE = String.raw`{
  if (typeof recordAppContainerProbeStage === 'function') recordAppContainerProbeStage('child-stdio-started');
  const child = require('node:child_process').spawnSync(process.execPath,
    ['-e', "process.stdout.write(require('node:fs').readFileSync(0,'utf8'));process.stderr.write('yuantu-stderr');"],
    {input:'yuantu-stdin',encoding:'utf8',timeout:2000});
  if (typeof recordAppContainerProbeStage === 'function') recordAppContainerProbeStage('child-spawn-returned');
  if (child.error || child.status !== 0 || child.stdout !== 'yuantu-stdin' || child.stderr !== 'yuantu-stderr')
    throw Error('AppContainer child stdio capability probe failed: ' + (child.error?.code ?? child.status));
  if (typeof recordAppContainerProbeStage === 'function') recordAppContainerProbeStage('child-stdio-passed');
}`;

/** Only fixed probe stages may appear in a capability refusal. */
export function appContainerProbeFailure(
  stage: unknown,
  cancelled: boolean,
  error: unknown,
): string {
  const known = [
    'workspace-started',
    'child-stdio-started',
    'child-spawn-returned',
    'child-stdio-passed',
    'network-started',
    'complete',
  ];
  const phase = typeof stage === 'string' && known.includes(stage) ? stage : 'unknown';
  return `AppContainer enforcement probe ${cancelled ? 'timed out' : 'failed'} during ${phase}: ${String(error).slice(0, 2048)}`;
}
