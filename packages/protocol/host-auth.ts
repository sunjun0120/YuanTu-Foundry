/** TCP credentials are operator-provided, never sourced from a project or printed in diagnostics. */
export function hostAuthTokenProblem(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value)
    ? undefined
    : 'YUANTU_HOST_TOKEN must contain 32–512 ASCII letters, digits, underscores or hyphens';
}
