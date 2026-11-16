import { expect, test } from './support/fixtures.js'
import { GONE, LATE, mockLateStatus, seedIdleAgent } from './support/pr-lazy.js'

test.use({ allowedHttpStatuses: [503] })

test('a chip says its status is loading, and shows it once GitHub answered later', async ({ page }) => {
  const lookups = await mockLateStatus(page, 2)
  const id = await seedIdleAgent('E2E late status', [LATE, GONE])
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  const late = main.getByRole('group', { name: 'Pull request late#4' }).getByRole('link', { name: 'late#4' })
  const gone = main.getByRole('group', { name: 'Pull request late#5' }).getByRole('link', { name: 'late#5' })

  await expect(late).toHaveAttribute('title', 'Loading status')
  await expect(late).toHaveAttribute('aria-busy', 'true')
  await expect(gone).toHaveAttribute('title', 'No status from GitHub')
  await expect(gone).not.toHaveAttribute('aria-busy')

  await expect(late).toHaveAttribute('title', 'Arrives late', { timeout: 15_000 })
  await expect(late).not.toHaveAttribute('aria-busy')
  await expect(main.getByRole('group', { name: 'Pull request late#4' })).toContainText('ci pass')
  expect(lookups.count).toBe(3)
  await page.request.delete(`/api/tasks/${id}`)
})

test('a status lookup that fails is asked again instead of leaving the chip without one', async ({ page }) => {
  await mockLateStatus(page, 0)
  let calls = 0
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    calls += 1
    await (calls === 1
      ? route.fulfill({ status: 503, json: { error: { message: 'Seti is restarting' } } })
      : route.fallback())
  })
  const id = await seedIdleAgent('E2E failed lookup', [LATE])
  await page.goto(`/#agents/${id}`)
  const late = page.getByRole('main').getByRole('link', { name: 'late#4' })
  await expect(late).toHaveAttribute('title', 'Loading status')
  await expect(late).toHaveAttribute('title', 'Arrives late', { timeout: 15_000 })
  await page.request.delete(`/api/tasks/${id}`)
})
