import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { removeAllRoles, rolesSection, seedKeptLead } from './support/roles.js'

test('the Roles section with none fits a phone, and its Add opens a new role', async ({ page, request }) => {
  await removeAllRoles(request)
  await page.goto('/#context')
  const empty = rolesSection(page).getByTestId('no-roles')
  await expect(empty).toHaveText(/^No roles yet\./)
  await empty.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'Context page with no roles')
  const add = empty.getByRole('button', { name: 'Add' })
  expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await add.tap()
  await expect(page.getByRole('main').getByRole('heading', { name: 'New role' })).toBeVisible()
  await expectFitsPhone(page, 'new role editor')
})

test('a role kept from the built-in ones fits a phone and opens for editing', async ({ page, request }) => {
  await removeAllRoles(request)
  const lead = await seedKeptLead()
  await page.goto('/#context')
  const item = rolesSection(page).getByRole('button', { name: /^Lead / })
  await item.scrollIntoViewIfNeeded()
  await expect(item).not.toContainText('Built in')
  await expectFitsPhone(page, 'Context page with one kept role')
  await item.tap()
  const main = page.getByRole('main')
  await expect(main.getByLabel('Role content')).toHaveValue(/^Lead: you run a stream of work/)
  await expect(main.getByRole('button', { name: 'Delete role' })).toBeVisible()
  await expectFitsPhone(page, 'kept role editor')
  await request.delete(`/api/context/packs/${lead.id}`)
  expect((await request.delete(`/api/tasks/${lead.task}`)).ok()).toBe(true)
})
