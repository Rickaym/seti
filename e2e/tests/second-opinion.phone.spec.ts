import { expect, test, unique } from './support/fixtures.js'
import { linkManyPrs, manyPrUrl } from './support/many-prs.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { OPINION, PR_REVIEW, seedPrReview, seedSecondOpinion } from './support/second-opinions.js'

test('a second opinion fits a phone on one line, closed and open', async ({ page }) => {
  const id = await seedSecondOpinion(unique('Phone opinion'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(OPINION.after)).toBeVisible()
  const row = pane.locator('details', { has: page.getByTestId('opinion-model') })
  await expect(row.getByTestId('opinion-model')).toHaveText('Asked gpt-5.5:')
  await expect(row.getByTestId('opinion-cost')).toBeVisible()
  const summary = row.locator('summary')
  expect((await summary.boundingBox())?.height).toBeLessThan(80)
  const asked = await row.getByTestId('tool-summary').boundingBox()
  expect(asked?.width, 'the question has most of the line').toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.4)
  await expectFitsPhone(page, 'a closed second opinion')
  await page.screenshot({ path: test.info().outputPath('second-opinion-phone-closed.png') })
  await summary.tap()
  await expect(row.getByRole('region', { name: 'Answer' })).toContainText('flush() in queue.ts')
  await expectFitsPhone(page, 'an open second opinion')
  await page.screenshot({ path: test.info().outputPath('second-opinion-phone-open.png') })
})

test('a light review of a linked PR folds under its row in the phone sheet', async ({ page }) => {
  const id = await seedSecondOpinion(unique('Phone review'))
  await linkManyPrs(id, 2)
  await seedPrReview(id, manyPrUrl(2))
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  const review = sheet.getByTestId('pr-review')
  await expect(review).toContainText('Reviewed by gpt-5.5 on Codex')
  await review.locator('summary').tap()
  await expect(review).toContainText(PR_REVIEW)
  await expectFitsPhone(page, 'a PR review in the sheet')
  await page.screenshot({ path: test.info().outputPath('second-opinion-pr-review.png') })
})
