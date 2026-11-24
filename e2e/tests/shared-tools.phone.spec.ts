import { expect, test, toasts, unique, waitForToastsToClear } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { proposeTool, sharedTool, startToolsmith } from './support/shared-tools.js'

const LONG_LINE = `print("${'a line much wider than a phone '.repeat(6)}")`
const SCRIPT = `#!/usr/bin/env python3\n${LONG_LINE}\n`

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a phone reviews a proposed tool, allows it, reads its code, turns it off and removes it', async ({
  page,
  request,
}) => {
  const agent = await startToolsmith(request)
  const name = unique('invoices')
  await proposeTool(request, agent, name, SCRIPT)

  await page.goto(`/#agents/${agent.id}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText(`Publish the shared tool ${name}?`)
  await expect(card.getByRole('list', { name: 'Arguments' })).toContainText('customer string, required')
  await expect(card.getByRole('region', { name: `Code of ${name}` })).toHaveText(SCRIPT)
  await card.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'shared tool proposal')
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  await expectTouchTarget(allow)
  await allow.tap()
  await expect(card).toHaveCount(0)
  expect(await sharedTool(request, name)).toMatchObject({ enabled: true })

  await page.goto('/#settings/tools')
  const tool = page.getByRole('main').locator(`[data-shared-tool="${name}"]`)
  await expect(tool).toContainText('BILLING_KEY for api.billing.example.com')
  await tool.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'shared tools in settings')
  await tool.getByRole('button', { name: `Code of ${name}` }).tap()
  const dialog = page.getByRole('dialog', { name: `Code of ${name}` })
  await expect(dialog.getByRole('region', { name: `Code of ${name}` })).toHaveText(SCRIPT)
  await expectFitsPhone(page, 'shared tool code')
  await dialog.getByRole('button', { name: 'Close' }).tap()
  await expect(dialog).toBeHidden()

  await tool.getByRole('switch', { name: `${name} on` }).tap()
  await expect(toasts(page).filter({ hasText: `${name} is off` })).toBeVisible()
  expect(await sharedTool(request, name)).toMatchObject({ enabled: false })
  await waitForToastsToClear(page)
  await tool.getByRole('button', { name: `Remove ${name}` }).tap()
  const confirm = page.getByRole('dialog', { name: `Remove ${name}` })
  await confirm.getByRole('button', { name: 'Remove' }).tap()
  await expect(toasts(page).filter({ hasText: `Removed ${name}` })).toBeVisible()
  await expect(tool).toBeHidden()
  expect(await sharedTool(request, name)).toBeUndefined()
})
