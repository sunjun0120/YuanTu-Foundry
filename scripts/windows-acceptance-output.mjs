export function assertAcceptanceOutput(output, code) {
  const matches = [
    ...output.matchAll(
      /^Tests: (\d+) pass=(\d+) fail=(\d+) skip=(\d+) cancelled=(\d+) todo=(\d+) duration=([\d.]+)s\s*$/gm,
    ),
  ];
  const last = matches.at(-1);
  if (!last) throw new Error('Windows acceptance has no completed test summary');
  const [tests, passed, failed, skipped, cancelled, todo, seconds] = last.slice(1).map(Number);
  if (code !== 0 || tests < 1 || passed !== tests || failed || skipped || cancelled || todo)
    throw new Error(
      'Windows acceptance requires a nonempty passing run with no skips, cancellations or todo',
    );
  // Every file's summary is checked, not only the last: the run prints one line per acceptance file, so a run
  // whose final file passed while an earlier one failed would otherwise be accepted on its last line alone.
  for (const match of matches) {
    const [, childTests, childPassed, childFailed, childSkipped, childCancelled, childTodo] =
      match.map(Number);
    if (
      childFailed ||
      childSkipped ||
      childCancelled ||
      childTodo ||
      childPassed < childTests ||
      childTests < 1
    )
      throw new Error(
        'Every Windows acceptance file has to pass with no skips, cancellations or todo',
      );
  }
  return { tests, passed, failed, skipped, cancelled, todo, seconds };
}
