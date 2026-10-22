import type { Locator, Page } from 'playwright';

/** New work can be the main guided action or the secondary action beside an existing result. */
export async function graphicsPreparationControl(page: Page) {
  const explicit = page.getByTestId('graphics-prepare');
  return await explicit.count() ? explicit : page.getByTestId('graphics-guide-primary');
}

/** Follow the visible disclosure path as a user would before interacting with a nested control. */
export async function revealGraphicsControl(control: Locator) {
  await control.waitFor({ state: 'attached' });
  while (await control.locator('xpath=ancestor::details[not(@open)]').count()) {
    await control.locator('xpath=ancestor::details[not(@open)]').first().locator(':scope > summary').click();
  }
}

export async function openGraphicsInspection(page: Page) {
  for (const selector of ['.gs-version-detail:not([open]) > summary', '.gs-recent-status:not([open]) > summary']) {
    const summary = page.locator(selector);
    if (await summary.count()) await summary.click();
  }
}
