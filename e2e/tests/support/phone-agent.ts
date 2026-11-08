import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** A row of the open More actions sheet, by its label; a row with a count adds it after a comma. */
export const moreRow = (page: Page, label: string): Locator =>
  page
    .getByRole('dialog', { name: 'Agent actions' })
    .getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`) })

/** Taps a row of the phone agent's More actions sheet. */
export async function tapMoreAction(page: Page, name: string): Promise<void> {
  await page.getByTestId('agent-header').getByRole('button', { name: 'More actions' }).tap()
  await moreRow(page, name).tap()
}

/** Opens the phone agent's linked PRs from the PR button in its header. */
export async function openAgentPrs(page: Page): Promise<Locator> {
  await page.getByTestId('agent-header').getByTestId('prs-button').tap()
  const sheet = page.getByRole('dialog', { name: /^Linked PRs/ })
  await expect(sheet).toBeVisible()
  return sheet
}
