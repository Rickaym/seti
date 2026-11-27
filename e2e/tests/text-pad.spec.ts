import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { clearPad, expectSaved, pad } from './support/text-pad.js'

test.afterEach(async ({ request }) => {
  await clearPad(request)
})

const openPad = async (page: Page) => {
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Pad' }).click()
  return page.getByRole('dialog', { name: 'Pad' })
}

test('the pad sits at the bottom of the rail, saves as you type and is there after a reload', async ({
  page,
  request,
}) => {
  await page.goto('/')
  const rail = page.getByRole('complementary', { name: 'Sidebar' })
  const button = rail.getByRole('button', { name: 'Pad' })
  const shortcuts = rail.getByRole('button', { name: 'Shortcuts' })
  const [padBox, toolsBox] = [await button.boundingBox(), await shortcuts.boundingBox()]
  expect(padBox?.y ?? 0, 'the pad sits under the sections, above the tools').toBeLessThan(toolsBox?.y ?? 0)

  const dialog = await openPad(page)
  const field = pad(dialog)
  await expect(field).toBeEditable()
  expect((await field.boundingBox())?.height ?? 0, 'the dialog gives the pad its height').toBeGreaterThan(300)
  await field.fill('milk\neggs')
  await expectSaved(request, 'milk\neggs')

  await page.reload()
  await expect(pad(await openPad(page))).toHaveValue('milk\neggs')
})

test.describe('while the server fails', () => {
  test.use({ allowedHttpStatuses: [503] })

  test('a failed save keeps the text, says so until a retry works', async ({ page, request }) => {
    await page.goto('/')
    const field = pad(await openPad(page))
    await expect(field).toBeEditable()
    await page.route('**/api/mods/text-pad/text', async (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 503, body: 'down' }) : route.fallback(),
    )
    await field.fill('keep this')
    await expect(page.getByRole('alert').filter({ hasText: 'Not saved, retrying' })).toBeVisible()
    await expect(field).toHaveValue('keep this')
    await page.unroute('**/api/mods/text-pad/text')
    await expectSaved(request, 'keep this')
    await expect(page.getByRole('alert').filter({ hasText: 'Not saved' })).toHaveCount(0)
  })
})

test('the pad takes newer text from another device when the app regains focus', async ({ page, request }) => {
  await page.goto('/')
  const field = pad(await openPad(page))
  await expect(field).toBeEditable()
  const response = await request.put('/api/mods/text-pad/text', { data: { text: 'from the phone' } })
  expect(response.status()).toBe(200)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(field).toHaveValue('from the phone')
})

test('the server refuses a pad past its limit with a reason', async ({ request }) => {
  const response = await request.put('/api/mods/text-pad/text', { data: { text: 'x'.repeat(20_001) } })
  expect(response.status()).toBe(422)
  expect(await response.text()).toContain('The pad holds at most 20,000 characters')
})

test('turning the Pad mod off takes the pad out of the rail', async ({ page, request }) => {
  await page.goto('/')
  const button = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Pad' })
  await expect(button).toBeVisible()
  await request.patch('/api/mods/text-pad', { data: { enabled: false } })
  await page.reload()
  await expect(
    page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }),
  ).toBeVisible()
  await expect(button).toHaveCount(0)
  await request.patch('/api/mods/text-pad', { data: { enabled: true } })
})
