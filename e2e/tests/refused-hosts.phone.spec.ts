import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { seedRefusedHost } from './support/refused-hosts.js'

test('a refused host line fits the phone, and Allow host works with taps', async ({ page }) => {
  const { id, host } = await seedRefusedHost(unique('Phone fetcher'))
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByText(`Sandbox refused ${host} (41 times)`)).toBeVisible()
  const allowHost = main.getByRole('button', { name: 'Allow host' })
  await expectTouchTarget(allowHost, 'Allow host')
  await expectFitsPhone(page, 'refused host line')
  await page.screenshot({ path: test.info().outputPath('refused-host-phone.png') })

  await allowHost.tap()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(`Lets the agent reach ${host}`)
  await expectFitsPhone(page, 'Allow host popover')
  await page.screenshot({ path: test.info().outputPath('refused-host-popover-phone.png') })
  await dialog.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(main.getByText('Allowed', { exact: true })).toBeVisible()
})
