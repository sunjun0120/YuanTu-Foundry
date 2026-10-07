/** Wait for a page condition, including predicates that make asynchronous bridge requests. */
export async function waitForPage(page, predicate, arg, options = {}) {
  const timeout = options.timeout ?? 15_000;
  const deadline = Date.now() + timeout;
  do {
    const result = await page.evaluate(predicate, arg);
    if (result) return result;
    if (timeout !== 0 && Date.now() >= deadline)
      throw new Error(`Timed out after ${timeout}ms waiting for the page condition`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
}
