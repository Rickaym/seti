import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const main = (page: Page) => page.getByRole('main')
const list = (page: Page) => main(page).getByRole('navigation', { name: 'Settings pages' })

async function openFromList(page: Page, label: string): Promise<void> {
  await page.goto('/#settings')
  await list(page).getByRole('button', { name: label, exact: true }).tap()
  await expect(main(page).getByRole('heading', { name: label, level: 2, exact: true })).toBeVisible()
  await expect(list(page)).toBeHidden()
}

test('the settings list gives every concern its own page, and each fits a phone', async ({ page }) => {
  await page.goto('/#settings')
  for (const name of ['General', 'Lifecycle', 'Notifications', 'Repos', 'About', 'Skills', 'Subagents', 'Sign-in']) {
    await expect(list(page).getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expectFitsPhone(page, 'settings list')

  await openFromList(page, 'Repos')
  await main(page).getByRole('button', { name: 'Create' }).tap()
  const add = page.getByRole('dialog', { name: 'Add repo' })
  await expect(add).toBeVisible()
  await expectFitsPhone(page, 'add repo')
  await add.getByRole('button', { name: 'Cancel' }).tap()
  await expect(add).toBeHidden()

  await openFromList(page, 'Lifecycle')
  await expect(main(page).getByRole('region', { name: 'Compaction' })).toBeVisible()
  const resume = main(page).getByRole('region', { name: 'Restarts' }).getByRole('button', { name: 'Resume' })
  await expect(resume).toHaveAttribute('aria-pressed', 'true')
  await resume.tap()
  await expect(resume).toHaveAttribute('aria-pressed', 'false')
  await resume.tap()
  await expect(resume).toHaveAttribute('aria-pressed', 'true')
  await expectFitsPhone(page, 'Lifecycle')

  await openFromList(page, 'General')
  await expect(main(page).getByRole('region', { name: 'Transcripts' })).toBeVisible()
  await expectFitsPhone(page, 'General')

  await openFromList(page, 'Subagents')
  await expect(main(page).getByRole('combobox', { name: 'Config scope' })).toBeVisible()
  await expectFitsPhone(page, 'Subagents')

  await openFromList(page, 'Sign-in')
  await expect(main(page).getByRole('region', { name: 'Phones' })).toBeVisible()
  await expect(main(page).getByRole('region', { name: 'Android app' })).toBeVisible()
  await expectFitsPhone(page, 'Sign-in')

  await openFromList(page, 'Credentials')
  await expect(main(page).getByRole('region', { name: 'Agent tokens' })).toBeVisible()
  await expectFitsPhone(page, 'Credentials')
  await main(page).getByRole('button', { name: 'Back to settings' }).tap()
  await expect(page).toHaveURL(/#settings$/)
})
