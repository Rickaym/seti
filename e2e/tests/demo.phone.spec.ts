import { CART_AGENT, DEMO_WORKER, enterDemo, INFRA_AGENT } from './support/demo.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.use(DEMO_WORKER)

test('a visitor on a phone enters the demo, reads that it is not real and answers an agent', async ({ page }) => {
  await enterDemo(page)
  await expectFitsPhone(page, 'demo agents')

  const needsYou = page.getByRole('main').getByRole('region', { name: 'Needs you' })
  await expect(needsYou).toContainText(CART_AGENT)
  await needsYou.getByText(INFRA_AGENT).first().tap()
  const card = page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText('terraform apply')
  await expectFitsPhone(page, 'demo permission request')
  await card.getByRole('button', { name: 'Deny' }).tap()
  await expect(page.getByRole('main').getByText(/I did not deploy/)).toBeVisible()
})
