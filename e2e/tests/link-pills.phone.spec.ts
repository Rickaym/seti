import { expect, test, unique } from './support/fixtures.js'
import { LINKS, seedLinkPills } from './support/link-pills.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('link pills show their names on a phone, and a long URL fits the screen', async ({ page }) => {
  const id = await seedLinkPills(unique('Phone link pills'))
  await page.goto(`/#agents/${id}`)
  const reply = page
    .getByRole('region', { name: 'Transcript' })
    .locator('[data-find-text]')
    .filter({ hasText: 'Setup steps are in' })

  await expect(reply.getByRole('link', { name: LINKS.slack.label })).toHaveAttribute('href', LINKS.slack.url)
  await expect(reply.getByRole('link', { name: LINKS.pr.label })).toHaveAttribute('href', LINKS.pr.url)
  await expect(reply.getByRole('link', { name: LINKS.plain.label })).toHaveAttribute('href', LINKS.plain.url)

  const long = reply.locator(`a[href="${LINKS.long.url}"]`)
  await expect(long).toHaveAttribute('data-link-pill', 'web')
  await expect(long).toContainText(LINKS.long.label)
  await long.scrollIntoViewIfNeeded()
  const box = await long.boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(box).not.toBeNull()
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width)
  await expectFitsPhone(page, 'a transcript with link pills')
})
