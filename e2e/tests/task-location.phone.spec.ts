import { expect, test } from './support/fixtures.js'
import { seedOlderAgent } from './support/older-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TARGET_PX = 44

test("a phone reads an older agent's folders and takes its home folders away", async ({ page, request }) => {
  const { id, slug, notes } = await seedOlderAgent('Phone older agent')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  const sheet = page.getByRole('dialog').filter({ has: page.getByRole('tablist', { name: 'Sections' }) })
  for (const name of [slug, notes]) {
    const copy = sheet.getByRole('group', { name }).getByRole('button', { name: /^Copy path of / })
    await expect(copy).toBeVisible()
    expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TARGET_PX)
  }
  for (const gone of [/^Add/, /^Work in /, /^Remove /]) {
    await expect(sheet.getByRole('button', { name: gone })).toHaveCount(0)
  }
  await expectFitsPhone(page, 'the agent settings')

  await sheet.getByRole('tab', { name: 'Access', exact: true }).tap()
  const access = sheet.getByRole('tabpanel', { name: 'Access' })
  const remove = access.getByRole('button', { name: 'Remove', exact: true })
  await expect(remove).toBeVisible()
  await remove.tap()
  const confirm = page.getByRole('dialog', { name: 'Remove home folders?' })
  await expect(confirm).toContainText('can read and write the folders in your home')
  await confirm.getByRole('button', { name: 'Remove', exact: true }).tap()
  await expect(access.locator('dt').filter({ hasText: /^Home folders$/ })).toHaveCount(0)
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
