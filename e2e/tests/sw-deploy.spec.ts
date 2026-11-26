import {
  BUILD_B,
  countLoads,
  deployBuildB,
  expectOnBuildB,
  expectPageOnBuildB,
  openControlled,
  pageBuild,
  seedIdleAgent,
} from './support/deploy.js'
import { expect, test } from './support/fixtures.js'

test.use({
  serviceWorkers: 'allow',
  allowedHttpStatuses: [503],
  allowedConsoleErrors: [/bad HTTP response code \(503\) was received when fetching the script/],
})
test.describe.configure({ timeout: 90_000 })

test('an idle open page moves to a new build by itself', async ({ page, context, request }) => {
  const before = await openControlled(page)
  expect(before).not.toBe(BUILD_B)
  await deployBuildB(context, request)

  await expectOnBuildB(page)
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(
    /\/sw\.js\?build=e2e-build-b$/,
  )
})

test('a page with text in the Reply box offers Update, then keeps the draft', async ({ page, context, request }) => {
  const id = await seedIdleAgent('E2E update draft')
  await openControlled(page, `#agents/${id}`)
  const reply = page.getByRole('main').getByRole('combobox', { name: 'Reply' })
  await reply.fill('Half a thought about the deploy')
  const loads = countLoads(page)
  await deployBuildB(context, request)

  const update = page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })
  await expect(update).toBeVisible({ timeout: 20_000 })
  await expect(update).toHaveAttribute('data-tone', 'default')
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system')
  expect(loads()).toBe(0)
  await expect(reply).toHaveValue('Half a thought about the deploy')

  await update.click()
  await expectOnBuildB(page)
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Reply' })).toHaveValue(
    'Half a thought about the deploy',
  )
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })).toBeHidden()
})

test('a reload after a deploy shows the new build, never the old one', async ({ page, context, request }) => {
  await openControlled(page)
  await deployBuildB(context, request)

  await page.reload()
  await expect(pageBuild(page)).toHaveAttribute('content', BUILD_B)
  await expectOnBuildB(page)
  await page.reload()
  await expect(pageBuild(page)).toHaveAttribute('content', BUILD_B)
})

test('a 503 for sw.js while Seti restarts is tried again and the page still updates', async ({
  page,
  context,
  request,
}) => {
  await openControlled(page)
  const deploy = await deployBuildB(context, request, { workerOutages: 2 })

  await expectPageOnBuildB(page)
  expect(deploy.workerAnswers.slice(0, 3)).toEqual([503, 503, 200])
})
