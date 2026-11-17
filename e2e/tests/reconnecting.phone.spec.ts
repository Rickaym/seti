import { expect, test, toasts } from './support/fixtures.js'
import { DROPPED_REQUEST, loseLink, seedListedAgent } from './support/lost-link.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.use({ allowedConsoleErrors: [DROPPED_REQUEST] })

test('a lost link on a phone turns Health into one Reconnecting item, with no toast and the list kept', async ({
  page,
}) => {
  const title = await seedListedAgent()
  await page.clock.install()
  await page.goto('/#agents')
  const agent = page.getByText(title).first()
  await expect(agent).toBeVisible()
  const health = page.getByRole('contentinfo').getByRole('button', { name: /^Health: / })
  await expect(health).toContainText('Health')

  const restore = await loseLink(page)
  for (let round = 0; round < 6; round += 1) {
    await page.clock.runFor(5000)
  }
  await expect(health).toContainText('Reconnecting')
  await expect(health).not.toHaveAttribute('data-tone', 'danger')
  await expect(page.getByRole('contentinfo').getByText('Reconnecting')).toHaveCount(1)
  await expect(toasts(page)).toHaveCount(0)
  await expect(agent).toBeVisible()
  await expectFitsPhone(page, 'reconnecting')

  await health.tap()
  const row = page.getByRole('dialog', { name: 'Health' }).getByRole('status', { name: 'API reconnecting' })
  await expect(row).toContainText('The Seti server is not answering.')
  await expect(row).toHaveAttribute('data-tone', 'muted')
  await expectFitsPhone(page, 'health sheet while reconnecting')
  await page.keyboard.press('Escape')

  await restore()
  await page.clock.runFor(5000)
  await expect(health).not.toContainText('Reconnecting')
  await expect(health).toContainText('Health')
  await expect(toasts(page)).toHaveCount(0)
  await expect(agent).toBeVisible()
})
