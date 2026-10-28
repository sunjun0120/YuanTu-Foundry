import { tmpdir } from 'node:os';
import path from 'node:path';

/** Helpers the desktop smoke files share. */

/**
 * The text of one wire message.
 *
 * A provider may send a user message as a string or as text blocks, and the smoke fixtures have to read both:
 * keying on `typeof content === 'string'` silently misses every block-shaped prompt.
 */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '',
      )
      .join('');
  return '';
}

/**
 * Whether this request is the automatic-verification nudge.
 *
 * The nudge is a user-role message, not a user instruction; a fixture that keys on the last tool result would
 * otherwise answer it by starting the same command again. Answer it with the final answer instead.
 */
export function verificationNudge(body) {
  const last = body?.messages?.at(-1);
  return last?.role === 'user' && messageText(last.content).includes('no verification checks yet');
}

/** Approval-specific fixtures choose guarded explicitly instead of relying on the auto default. */
export async function choosePermissionPreset(page, preset) {
  await page.locator('#permission-trigger').click();
  await page.locator(`#permission-menu [data-preset="${preset}"]`).click();
  await page.waitForFunction(
    (value) =>
      document.querySelector('#permission-mode').value === value &&
      !document.querySelector('#permission-mode').disabled,
    preset,
  );
}

/**
 * Choose a value from a Mantine `Select` by the label a person reads.
 *
 * A Mantine Select is not a `<select>`: the input is read-only and shows the option's *label*, and the options live
 * in a portal the select opens. `selectOption()` therefore cannot drive it — clicking the field and then the option
 * is what a person does.
 *
 * The wait is on the list closing, not on the field's value: choosing a language changes that option's label in the
 * same save (中文 becomes "Chinese"), so a value comparison would wait forever.
 */
export async function chooseSelectOption(page, id, label) {
  await page.locator(`#${id}`).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
}

/** Read a Mantine Select's option labels by opening it, then close it again. */
export async function readSelectOptions(page, id) {
  await page.locator(`#${id}`).click();
  const labels = await page.getByRole('option').allTextContents();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  return labels;
}

/**
 * The same, for a Select that has no id: a field inside a card or form, addressed by its visible label.
 *
 * `scope` is the locator that owns the field (`form.task-schedule`, `article.task-card`); the option list still lives
 * in the body portal, so the click lands on the page rather than on the scope.
 */
export async function chooseLabeledOption(scope, label, option) {
  await scope.getByLabel(label, { exact: true }).click();
  await scope.page().getByRole('option', { name: option, exact: true }).click();
  await scope.page().getByRole('listbox').waitFor({ state: 'hidden' });
}

/** Polls `check` every 100 ms until it is truthy, failing after `ms`. */
export async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Launcher did not reach expected state');
}

/**
 * Pin the window's content box, so a test of a narrow layout runs at that width on every desktop.
 *
 * The window opens at the product's default 1220x860, which is wider than some CI displays: a runner that
 * cannot fit it lays the page out narrower, and a test that never said which width it exercises passes
 * locally and fails there. `setContentSize` is in DIPs, the same unit media queries read.
 */
export async function setWindowContentSize(app, page, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForFunction(
    (size) => Math.abs(innerWidth - size.width) <= 2 && Math.abs(innerHeight - size.height) <= 2,
    { width, height },
  );
}

/** Where a smoke run writes screenshots and other artifacts a person may want to look at. */
export function artifactPath(relative) {
  return path.join(
    process.env.FOUNDRY_TEST_ARTIFACTS ||
      path.join(tmpdir(), 'yuantu-smoke-artifacts-' + process.pid),
    relative,
  );
}
