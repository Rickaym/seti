import { seedMentions } from './support/file-mentions.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TARGET_PX = 44

test('a tap on a file chip or card opens Files, and the chip is a full touch target', async ({ page }) => {
  const { id } = await seedMentions(unique('Mentions phone'))
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })

  const chip = transcript.getByRole('button', { name: 'Open notes/plan.md in Files' })
  await expect(chip).toBeVisible()
  const card = transcript.locator('[data-file-card][data-file-link="src/greet.ts"]')
  await expect(card).toBeVisible()
  await expectFitsPhone(page, 'file chip and card')

  const reach = await chip.evaluate((element) => {
    const after = getComputedStyle(element, '::after')
    return { position: after.position, height: Number.parseFloat(after.height) }
  })
  expect(reach.position).toBe('absolute')
  expect(reach.height).toBeGreaterThanOrEqual(TARGET_PX)
  expect((await chip.boundingBox())?.height ?? 0).toBeLessThan(TARGET_PX / 2)

  await chip.tap()
  await expect(page.getByRole('region', { name: 'File notes/plan.md' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Launch plan' })).toBeVisible()

  await page.getByRole('button', { name: 'Close Files' }).tap()
  await card.tap()
  await expect(page.getByRole('region', { name: 'File src/greet.ts' })).toBeVisible()

  await page.getByRole('button', { name: 'Close Files' }).tap()
  const own = transcript.locator('[data-own-message]').filter({ hasText: 'Start from' })
  await own.locator('[data-file-card][data-file-link="src/farewell.ts"]').tap()
  await expect(page.getByRole('region', { name: 'File src/farewell.ts' })).toBeVisible()
})
