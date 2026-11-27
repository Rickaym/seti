import {
  countLoads,
  expectOnNewBuild,
  expectPageOnNewBuild,
  OLD_BUILD,
  openControlled,
  pageBuild,
  seedIdleAgent,
  serveOldBuild,
} from './support/deploy.js'
import { expect, test } from './support/fixtures.js'

test.use({
  serviceWorkers: 'allow',
  allowedHttpStatuses: [503],
  allowedConsoleErrors: [/bad HTTP response code \(503\) was received when fetching the script/],
})
test.describe.configure({ timeout: 90_000 })

test('an idle open page moves to a new build by itself', async ({ page, context, request }) => {
  const deploy = await serveOldBuild(context, request)
  expect(await openControlled(page)).toBe(OLD_BUILD)
  await deploy.run()

  await expectOnNewBuild(page, deploy)
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(
    new RegExp(`/sw\\.js\\?build=${deploy.build}$`),
  )
})

test('a page with text in the Reply box offers Update, then keeps the draft', async ({ page, context, request }) => {
  const id = await seedIdleAgent('E2E update draft')
  const deploy = await serveOldBuild(context, request)
  await openControlled(page, `#agents/${id}`)
  const reply = page.getByRole('main').getByRole('combobox', { name: 'Reply' })
  await reply.fill('Half a thought about the deploy')
  const loads = countLoads(page)
  await deploy.run()

  const update = page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })
  await expect(update).toBeVisible({ timeout: 20_000 })
  await expect(update).toHaveAttribute('data-tone', 'default')
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system')
  expect(loads()).toBe(0)
  await expect(reply).toHaveValue('Half a thought about the deploy')

  await update.click()
  await expectOnNewBuild(page, deploy)
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Reply' })).toHaveValue(
    'Half a thought about the deploy',
  )
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })).toBeHidden()
})

test('a reload after a deploy shows the new build, never the old one', async ({ page, context, request }) => {
  const deploy = await serveOldBuild(context, request)
  await openControlled(page)
  await deploy.run()

  await page.reload()
  await expect(pageBuild(page)).toHaveAttribute('content', deploy.build)
  await expectOnNewBuild(page, deploy)
  await page.reload()
  await expect(pageBuild(page)).toHaveAttribute('content', deploy.build)
})

test('a 503 for sw.js while Seti restarts is tried again and the page still updates', async ({
  page,
  context,
  request,
}) => {
  const deploy = await serveOldBuild(context, request)
  await openControlled(page)
  const { workerAnswers } = await deploy.run({ workerOutages: 2 })

  await expectPageOnNewBuild(page, deploy)
  expect(workerAnswers.slice(0, 3)).toEqual([503, 503, 200])
})
