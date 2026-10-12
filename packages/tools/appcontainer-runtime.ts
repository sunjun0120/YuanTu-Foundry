/** libuv 1.53 fixes container-local names for child stdio pipes (upstream #5181). */
export function appContainerRuntimeError(uv: string | undefined): string | null {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(uv ?? '');
  if (parts && (Number(parts[1]) > 1 || (Number(parts[1]) === 1 && Number(parts[2]) >= 53)))
    return null;
  return `Windows AppContainer requires libuv >=1.53.0 for child stdio pipes; current runtime has ${uv ?? 'unknown'}. Use a compatible bundled Node runtime.`;
}
