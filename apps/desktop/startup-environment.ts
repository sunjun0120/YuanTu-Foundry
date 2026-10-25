import { CarrierError } from '../../packages/carrier/errors.ts';
import { environmentProblems } from '../../packages/protocol/settings.ts';

/** Match the carrier's spawn merge; diagnostics contain names and reasons, never values. */
export function startupEnvironmentProblems(
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): string[] {
  return environmentProblems({ ...inherited, ...overrides }).map(
    ({ key, problem }) =>
      `${key}: ${problem.replace(/(?: \(got "[\s\S]*"\)|; got "[\s\S]*")$/u, '')}`,
  );
}

export function startupEnvironmentCheck(problems: readonly string[]): (() => void) | undefined {
  return problems.length
    ? () => {
        throw new CarrierError('environmentInvalid', { problems: problems.join('；') });
      }
    : undefined;
}
