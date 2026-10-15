import type { Locator, Page } from 'playwright';

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
