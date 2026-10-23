/**
 * Polls until a condition holds, for state a test cannot await directly (a background turn, a child that has
 * only just started). The timeout is generous because it only matters when the test is already failing.
 */
export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
