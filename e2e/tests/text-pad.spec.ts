import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { clearPad, expectSaved, pad } from './support/text-pad.js'

test.afterEach(async ({ request }) => {
  await clearPad(request)
})

const rail = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const panel = (page: Page) => page.getByRole('region', { name: 'Pad' })

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

const openPad = async (page: Page) => {
  await rail(page).getByRole('button', { name: 'Pad' }).click()
  return panel(page)
}

test('the pad sits at the bottom of the rail, opens beside it and saves as you type', async ({ page, request }) => {
  await page.goto('/')
  const button = rail(page).getByRole('button', { name: 'Pad' })
  const shortcuts = rail(page).getByRole('button', { name: 'Shortcuts' })
  const [padBox, toolsBox] = [await boxOf(button), await boxOf(shortcuts)]
  expect(padBox.y, 'the pad sits under the sections, above the tools').toBeLessThan(toolsBox.y)
  const mainBefore = await boxOf(page.getByRole('main'))

  const open = await openPad(page)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(open.getByRole('textbox')).toHaveCount(1)
  await expect(open.getByRole('button'), 'the pad holds nothing but its text area').toHaveCount(0)
  const field = pad(open)
  await expect(field).toBeEditable()
  const [railBox, fieldBox, mainBox] = [
    await boxOf(rail(page)),
    await boxOf(field),
    await boxOf(page.getByRole('main')),
  ]
  expect(fieldBox.height, 'the pad is as tall as the rail').toBeGreaterThan(railBox.height - 4)
  expect(mainBox.x, 'the page moves over rather than being covered').toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width)
  expect(mainBox.width).toBeLessThan(mainBefore.width)
  await field.fill('milk\neggs')
  await expectSaved(request, 'milk\neggs')

  await page.reload()
  await expect(pad(panel(page)), 'the panel stays open on this device').toHaveValue('milk\neggs')
  await pad(panel(page)).press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await button.click()
  await expect(pad(panel(page))).toHaveValue('milk\neggs')
  await button.click()
  await expect(panel(page)).toHaveCount(0)
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
