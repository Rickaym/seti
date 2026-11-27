import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { clearPad, expectSaved, pad } from './support/text-pad.js'

test.afterEach(async ({ request }) => {
  await clearPad(request)
})

const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Menu' }).tap()
  return page.getByRole('dialog')
}

test('the pad fills the drawer under the sections, saves itself and is there after a reload', async ({
  page,
  request,
}) => {
  await page.goto('/')
  const drawer = await openMenu(page)
  const field = pad(drawer)
  await expect(field).toBeEditable()
  const sections = drawer.getByRole('navigation', { name: 'Sections' })
  const [fieldBox, sectionsBox, terminal] = [
    await field.boundingBox(),
    await sections.boundingBox(),
    await drawer.getByRole('button', { name: 'Terminal', exact: true }).boundingBox(),
  ]
  const fieldBottom = (fieldBox?.y ?? 0) + (fieldBox?.height ?? 0)
  expect(fieldBox?.y ?? 0, 'the pad starts under the sections').toBeGreaterThanOrEqual(
    (sectionsBox?.y ?? 0) + (sectionsBox?.height ?? 0),
  )
  expect(Math.abs((terminal?.y ?? 0) - fieldBottom), 'the pad reaches down to the tools').toBeLessThan(12)
  expect(fieldBox?.height ?? 0, 'the pad keeps a usable height').toBeGreaterThanOrEqual(150)
  await expectFitsPhone(page, 'menu drawer with the pad')
  await field.tap()
  const slot = drawer.locator('[data-slot="nav-bottom"]')
  await expect(slot.getByRole('textbox')).toHaveCount(1)
  await expect(slot.getByRole('button'), 'the pad holds nothing but its text area').toHaveCount(0)

  await field.fill('pick up keys')
  await expectSaved(request, 'pick up keys')
  await page.reload()
  await expect(pad(await openMenu(page))).toHaveValue('pick up keys')
})

test('with the keyboard open the pad stays in view and the sections scroll', async ({ page }) => {
  await page.goto('/')
  const drawer = await openMenu(page)
  const field = pad(drawer)
  await expect(field).toBeEditable()
  await field.tap()
  const size = page.viewportSize() ?? { width: 390, height: 844 }
  await page.setViewportSize({ width: size.width, height: Math.round(size.height / 2) })
  await expect(field).toBeFocused()
  await expect(field).toBeInViewport({ ratio: 1 })
  expect((await field.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(150)
  const sections = drawer.getByRole('navigation', { name: 'Sections' })
  expect(await sections.evaluate((nav) => nav.scrollHeight > nav.clientHeight)).toBe(true)
})
