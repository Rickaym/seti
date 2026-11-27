import {
  countLoads,
  expectOnNewBuild,
  openControlled,
  seedIdleAgent,
  serveOldBuild,
  setPageHidden,
} from './support/deploy.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test.use({ serviceWorkers: 'allow' })
test.describe.configure({ timeout: 90_000 })

test('an app that resumes its old page moves to the new build once it is back in front', async ({
  page,
  context,
  request,
}) => {
  const deploy = await serveOldBuild(context, request)
  await openControlled(page)
  expect(await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY)).toBe('none')
  await setPageHidden(page, true)
  const loads = countLoads(page)
  await deploy.run()
  expect(loads()).toBe(0)

  await setPageHidden(page, false)
  await expectOnNewBuild(page, deploy)
})

test('a phone with a draft gets Update in the status bar and keeps the draft', async ({ page, context, request }) => {
  const id = await seedIdleAgent('E2E phone update draft')
  const deploy = await serveOldBuild(context, request)
  await openControlled(page, `#agents/${id}`)
  const reply = page.getByRole('main').getByRole('combobox', { name: 'Reply' })
  await reply.fill('A reply typed on the bus')
  await reply.blur()
  const loads = countLoads(page)
  await deploy.run()

  const update = page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })
  await expect(update).toBeVisible({ timeout: 20_000 })
  expect(loads()).toBe(0)
  await expectFitsPhone(page, 'Update in the status bar')
  await expectTouchTarget(update, 'Update', 'both')

  await update.tap()
  await expectOnNewBuild(page, deploy)
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Reply' })).toHaveValue('A reply typed on the bus')
})
