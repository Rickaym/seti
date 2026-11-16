import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { lazyList, mockLazyDetails, mockLists, seedIdleAgent } from './support/pr-lazy.js'

test('the phone picker mounts 20 of 60 PRs, loads their detail in one request and grows on scroll', async ({
  page,
}) => {
  await mockLists(page, [lazyList(60, { refreshing: true }), lazyList(60)])
  const asked = await mockLazyDetails(page)
  const id = await seedIdleAgent('Phone lazy picker')
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  await sheet.getByRole('button', { name: 'Link PR' }).tap()
  const rows = sheet.getByRole('button', { name: /lazy change \d+/ })
  await expect(rows).toHaveCount(20)
  await expect(rows.first().getByRole('img', { name: '2 unresolved review threads' })).toBeVisible()
  await expect(sheet.getByText('Refreshing from GitHub')).toBeVisible()
  expect(asked).toHaveLength(1)
  expect(asked[0]).toHaveLength(20)
  await expectFitsPhone(page, 'PR picker with a long list')

  await rows.last().scrollIntoViewIfNeeded()
  await expect(rows).toHaveCount(40)
  await expect.poll(() => asked.length).toBe(2)
  await expect(sheet.getByText('Refreshing from GitHub')).toBeHidden({ timeout: 10_000 })
  await page.request.delete(`/api/tasks/${id}`)
})
