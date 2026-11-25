import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { openReviewer, resetReviewer, reviewer } from './support/role-runtime.js'

test.afterEach(async ({ request }) => {
  await resetReviewer(request)
})

test("a role's model picker fits a phone and is big enough to tap", async ({ page, request }) => {
  const picker = await openReviewer(page)
  await expectFitsPhone(page, 'built-in role with its model picker')
  expect((await picker.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await picker.selectOption({ label: 'Haiku' })
  await expect.poll(async () => (await reviewer(request)).model).toBe('haiku')
})
