import type { Page } from '@playwright/test'
import type { CredentialProfile, CredentialsOverview } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const NAME = 'Phone client with a long name'

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.afterEach(async ({ request }) => {
  const overview = await apiData<CredentialsOverview>(request, '/credentials')
  for (const profile of overview.profiles.filter((entry) => !entry.builtin)) {
    await request.delete(`/api/credentials/profiles/${profile.id}`)
  }
})

test('credentials list and detail fit a phone', async ({ page, request }) => {
  const created = await request.post('/api/credentials/profiles', { data: { name: NAME } })
  const profile = ((await created.json()) as { data: CredentialProfile }).data
  await request.put(`/api/credentials/profiles/${profile.id}/aws`, {
    data: {
      role_arn: 'arn:aws:iam::123456789012:role/seti-agent-readonly-with-a-long-role-name',
      external_id: null,
      region: 'us-east-1',
      session_minutes: 60,
    },
  })

  await page.goto('/#settings/credentials')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Credentials', level: 2, exact: true })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Back to settings' })).toBeVisible()
  const row = main.getByRole('list', { name: 'Credentials' }).getByRole('listitem', { name: NAME })
  await expect(row).toContainText('seti-agent-readonly-with-a-long-role-name')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await row.getByRole('button').tap()
  await expect(main.getByRole('heading', { name: NAME, level: 2 })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Back to settings' })).toHaveCount(0)
  await expect(main.getByRole('region', { name: 'Connections' })).toBeVisible()
  const heading = await main.getByRole('heading', { name: NAME, level: 2 }).boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(heading === null ? Infinity : heading.x + heading.width).toBeLessThanOrEqual(width)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await main.getByRole('button', { name: 'Back to credentials' }).tap()
  await expect(page).toHaveURL(/#settings\/credentials$/)
  await expect(row).toBeVisible()
})
