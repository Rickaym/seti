import type { Page } from '@playwright/test'
import { BRIEF_LINE, seedDelegates } from './support/delegates.js'
import { expect, test, unique } from './support/fixtures.js'

const listedIds = async (page: Page) =>
  page
    .getByRole('main')
    .locator('[data-task-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-id')))

test('an agent started by another sits under it in the list and names it', async ({ page }) => {
  const lead = unique('Lead payments refactor')
  const ids = await seedDelegates(lead, unique('Helper migration tests'), unique('Unrelated docs'))
  await page.goto('/#agents')
  const helper = page.getByRole('main').locator(`[data-task-id="${ids.helper}"]`)
  await expect(helper.getByTestId('agent-delegate-mark')).toBeVisible()
  await expect(helper.getByRole('button')).toHaveAttribute('title', new RegExp(`Started by ${lead}`))
  await expect.poll(async () => listedIds(page)).toContain(ids.helper)
  const order = await listedIds(page)
  expect(order.indexOf(ids.helper), 'the helper comes right after its lead').toBe(order.indexOf(ids.lead) + 1)
  const leadRow = page.getByRole('main').locator(`[data-task-id="${ids.lead}"]`)
  await expect(leadRow.getByTestId('agent-delegate-mark')).toHaveCount(0)
  const [leadBox, helperBox] = await Promise.all([leadRow.boundingBox(), helper.boundingBox()])
  expect(helperBox?.height).toBe(leadBox?.height)
  await page.screenshot({ path: test.info().outputPath('delegates-desktop.png') })
  await helper.getByRole('button').click()
  const fold = page.getByRole('region', { name: 'Transcript' }).getByTestId('handover-brief')
  await expect(fold.locator('summary')).toHaveText(new RegExp(`Brief of ${lead}`))
  await fold.locator('summary').click()
  await expect(fold.getByText(BRIEF_LINE)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('delegates-desktop-brief.png') })
})
