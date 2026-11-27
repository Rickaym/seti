import { fakeEaPrompt } from './support/ea-prompt.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the EA prompt stays short on a phone and a long part scrolls inside its box', async ({ page }) => {
  await fakeEaPrompt(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Prompt' })
  await expect(card.getByTestId('ea-prompt-size')).toContainText('in 5 parts; build 0123456')
  expect((await card.boundingBox())?.height).toBeLessThan(700)
  const baseButton = card.getByRole('button', { name: /^Base prompt/ })
  await baseButton.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'EA prompt')
  await baseButton.tap()
  const base = card.getByRole('region', { name: 'Base prompt' })
  const pre = base.locator('pre')
  await expect(pre).toContainText('Rule 300')
  const viewport = page.viewportSize()?.height ?? 0
  expect((await pre.boundingBox())?.height).toBeLessThan(viewport * 0.65)
  const copy = base.getByRole('button', { name: 'Copy base prompt' })
  expect((await copy.boundingBox())?.width).toBeGreaterThanOrEqual(44)
  await expectFitsPhone(page, 'EA prompt open')
  const search = card.getByRole('searchbox', { name: 'Search prompt' })
  await search.tap()
  await search.fill('login redirect')
  await expect(card.getByRole('region', { name: 'Live context' }).locator('mark')).toHaveCount(1)
  await expectFitsPhone(page, 'EA prompt searched')
})
