import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { OPINION, seedSecondOpinion } from './support/second-opinions.js'

test('a second opinion fits a phone on one line, closed and open', async ({ page }) => {
  const id = await seedSecondOpinion(unique('Phone opinion'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(OPINION.after)).toBeVisible()
  const row = pane.locator('details', { has: page.getByTestId('opinion-model') })
  await expect(row.getByTestId('opinion-model')).toHaveText('Asked gpt-5.5:')
  await expect(row.getByTestId('opinion-cost')).toBeVisible()
  const summary = row.locator('summary')
  expect((await summary.boundingBox())?.height).toBeLessThan(60)
  await expectFitsPhone(page, 'a closed second opinion')
  await page.screenshot({ path: test.info().outputPath('second-opinion-phone-closed.png') })
  await summary.tap()
  await expect(row.getByRole('region', { name: 'Answer' })).toContainText('flush() in queue.ts')
  await expectFitsPhone(page, 'an open second opinion')
  await page.screenshot({ path: test.info().outputPath('second-opinion-phone-open.png') })
})
