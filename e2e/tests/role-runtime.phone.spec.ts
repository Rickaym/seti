import type { ContextPack } from '@seti/shared'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { newRole, openRole, removePacks, roleNow } from './support/roles.js'

const made: ContextPack[] = []

test.afterEach(async ({ request }) => {
  await removePacks(request, made.splice(0))
})

test("a role's model picker fits a phone and is big enough to tap", async ({ page, request }) => {
  const role = await newRole(request, 'Reviewer', 'you review PRs.')
  made.push(role)
  const picker = await openRole(page, role.name)
  await expectFitsPhone(page, 'role with its model picker')
  expect((await picker.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await picker.selectOption({ label: 'Haiku' })
  await expect.poll(async () => (await roleNow(request, role.id)).model).toBe('haiku')
})
