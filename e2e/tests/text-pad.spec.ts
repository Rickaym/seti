import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { clearPad, expectSaved, pad } from './support/text-pad.js'

test.afterEach(async ({ request }) => {
  await clearPad(request)
})

const rail = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const padWindow = (page: Page) => page.getByRole('region', { name: 'Pad', exact: true })

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

const openPad = async (page: Page) => {
  await rail(page).getByRole('button', { name: 'Pad', exact: true }).click()
  return padWindow(page)
}

/** Drags with the mouse from the middle of `from` by dx and dy. */
async function dragBy(page: Page, from: Locator, dx: number, dy: number) {
  const box = await boxOf(from)
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2)
  await page.mouse.move(x + dx, y + dy)
  await page.mouse.up()
}

test('the Pad icon opens a window over the page that saves as you type', async ({ page, request }) => {
  await page.goto('/')
  const button = rail(page).getByRole('button', { name: 'Pad', exact: true })
  const shortcuts = rail(page).getByRole('button', { name: 'Shortcuts' })
  const [padBox, toolsBox] = [await boxOf(button), await boxOf(shortcuts)]
  expect(padBox.y, 'the icon sits under the sections, above the tools').toBeLessThan(toolsBox.y)
  const mainBefore = await boxOf(page.getByRole('main'))

  const open = await openPad(page)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(pad(open)).toBeFocused()
  await expect(open.getByRole('textbox')).toHaveCount(1)
  const controls = await open.getByRole('button').evaluateAll((all) => all.map((b) => b.ariaLabel))
  expect(controls, 'the window holds its text area, a move handle and a close button').toEqual([
    'Move pad',
    'Close pad',
  ])
  expect(await boxOf(page.getByRole('main')), 'the page keeps its full width').toEqual(mainBefore)
  const windowBox = await boxOf(open)
  expect(windowBox.x, 'it opens beside the rail').toBeGreaterThanOrEqual(padBox.x + padBox.width)
  await pad(open).fill('milk\neggs')
  await expectSaved(request, 'milk\neggs')

  await open.getByRole('button', { name: 'Close pad' }).click()
  await expect(padWindow(page)).toHaveCount(0)
  await expect(button).toBeFocused()
  await button.click()
  await pad(padWindow(page)).press('Escape')
  await expect(padWindow(page)).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
})

test('the window moves and resizes, and a reload brings it back where it was', async ({ page }) => {
  await page.goto('/')
  const open = await openPad(page)
  await pad(open).fill('stays put')
  const start = await boxOf(open)
  await dragBy(page, open.getByRole('button', { name: 'Move pad' }), 200, -150)
  const dragged = await boxOf(open)
  expect([dragged.x - start.x, dragged.y - start.y]).toEqual([200, -150])
  await dragBy(page, open.locator('[data-resize="se"]'), 80, 60)
  const sized = await boxOf(open)
  expect([sized.width - dragged.width, sized.height - dragged.height]).toEqual([80, 60])
  expect([sized.x, sized.y]).toEqual([dragged.x, dragged.y])

  await page.reload()
  const back = padWindow(page)
  await expect(pad(back)).toHaveValue('stays put')
  expect(await boxOf(back)).toEqual(sized)
  await expect(pad(back), 'opening on load leaves focus alone').not.toBeFocused()

  await page.setViewportSize({ width: 900, height: 420 })
  await expect
    .poll(async () => {
      const box = await boxOf(back)
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= 900 && box.y + box.height <= 420
    }, 'a smaller viewport pulls the window into view')
    .toBe(true)
})

test('the arrow keys move the window and Shift with them resizes it', async ({ page }) => {
  await page.goto('/')
  const open = await openPad(page)
  const handle = open.getByRole('button', { name: 'Move pad' })
  await handle.focus()
  const start = await boxOf(open)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  const stepped = await boxOf(open)
  expect([stepped.x - start.x, stepped.y - start.y]).toEqual([16, -16])
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  const grown = await boxOf(open)
  expect([grown.width - stepped.width, grown.height - stepped.height]).toEqual([16, 16])
  await page.keyboard.press('Escape')
  await expect(padWindow(page)).toHaveCount(0)
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
  const button = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Pad', exact: true })
  await expect(button).toBeVisible()
  await request.patch('/api/mods/text-pad', { data: { enabled: false } })
  await page.reload()
  await expect(
    page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }),
  ).toBeVisible()
  await expect(button).toHaveCount(0)
  await request.patch('/api/mods/text-pad', { data: { enabled: true } })
})
