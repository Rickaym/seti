import type { AuditPage } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { apiData, expect, test, toasts, unique, waitForToastsToClear } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { proposeTool, sharedTool, startToolsmith, TOOL_DESCRIPTION, TOOL_REASON } from './support/shared-tools.js'

const FIRST = '#!/usr/bin/env python3\nimport json, sys\nprint("invoices of", json.load(sys.stdin)["customer"])\n'
const SECOND = '#!/usr/bin/env python3\nimport json, sys\nprint("open invoices of", json.load(sys.stdin)["customer"])\n'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('an agent proposes a tool, its card shows arguments and code, and it is published, updated and removed', async ({
  page,
  request,
}) => {
  const agent = await startToolsmith(request)
  const name = unique('invoices')
  const { requestId, hash } = await proposeTool(request, agent, name, FIRST)

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${agent.id}"]`)
  await expect(row).toContainText(`Asks for the shared tool ${name}`)
  await row.getByRole('button').first().click()
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText(`Publish the shared tool ${name}?`)
  await expect(card).toContainText(TOOL_DESCRIPTION)
  await expect(card).toContainText(TOOL_REASON)
  const args = card.getByRole('list', { name: 'Arguments' }).getByRole('listitem')
  await expect(args).toHaveText([
    'customer string, required: The customer id.',
    'limit integer, optional: How many to list.',
  ])
  await expect(card).toContainText('Declared read-only, stopped after 120 s')
  await expect(card.getByRole('list', { name: 'Needs' })).toContainText('BILLING_KEY for api.billing.example.com')
  await expect(card).toContainText(`invoices.py, sha256 ${hash.slice(0, 12)}`)
  await expect(card.getByRole('region', { name: `Code of ${name}` })).toHaveText(FIRST)
  await expect(card).toContainText('Every agent whose credential has BILLING_KEY will be able to run this')
  await expect(card).toContainText('An agent without the sandbox runs it with your access to this machine')
  await expect(card.getByRole('region', { name: `Changes to ${name}` })).toHaveCount(0)

  const refused = await request.post(`/api/tasks/${agent.id}/change-requests/${requestId}`, {
    headers: EA_HEADERS,
    data: { decision: 'allow' },
  })
  expect(refused.status()).toBe(403)
  expect(await sharedTool(request, name)).toBeUndefined()

  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
    `The user published your shared tool ${name}`,
  )
  expect(await sharedTool(request, name)).toMatchObject({ sha256: hash, enabled: true, proposer_title: agent.title })
  const audit = await apiData<AuditPage>(request, '/audit?kind=shared_tool.allowed&limit=1')
  expect(audit.events[0]).toMatchObject({
    actor: 'user',
    subject_id: name,
    detail: { sha256: hash, task_id: agent.id },
  })
  expect(JSON.stringify(audit.events[0])).not.toContain('invoices of')

  const update = await proposeTool(request, agent, name, SECOND)
  await page.reload()
  await expect(card).toContainText(`Update the shared tool ${name}?`)
  await expect(card).toContainText(`Replaces the published ${name}`)
  const changes = card.getByRole('region', { name: `Changes to ${name}` })
  await expect(changes.locator('[data-diff="del"]')).toHaveText(
    '-print("invoices of", json.load(sys.stdin)["customer"])',
  )
  await expect(changes.locator('[data-diff="add"]')).toHaveText(
    '+print("open invoices of", json.load(sys.stdin)["customer"])',
  )
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(await sharedTool(request, name)).toMatchObject({ sha256: update.hash })

  await page.goto('/#settings/tools')
  const main = page.getByRole('main')
  const tool = main.locator(`[data-shared-tool="${name}"]`)
  await expect(tool).toContainText(TOOL_DESCRIPTION)
  await expect(tool).toContainText(`Proposed by ${agent.title}`)
  await expect(tool).toContainText('Declared read-only')
  await expect(tool).toContainText('BILLING_KEY for api.billing.example.com')
  await expect(main).toContainText('in an agent without the sandbox it runs with that agent')
  await tool.getByRole('button', { name: `Code of ${name}` }).click()
  const dialog = page.getByRole('dialog', { name: `Code of ${name}` })
  await expect(dialog.getByRole('region', { name: `Code of ${name}` })).toHaveText(SECOND)
  await expect(dialog.getByRole('list', { name: 'Arguments' })).toContainText('customer string, required')
  await expect(dialog).toContainText(update.hash)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  await tool.getByRole('switch', { name: `${name} on` }).click()
  await expect(toasts(page).filter({ hasText: `${name} is off` })).toBeVisible()
  expect(await sharedTool(request, name)).toMatchObject({ enabled: false })
  const enabling = await request.patch(`/api/shared-tools/${name}`, { headers: EA_HEADERS, data: { enabled: true } })
  expect(enabling.status()).toBe(403)
  expect(await sharedTool(request, name)).toMatchObject({ enabled: false })

  await waitForToastsToClear(page)
  await tool.getByRole('button', { name: `Remove ${name}` }).click()
  const confirm = page.getByRole('dialog', { name: `Remove ${name}` })
  await expect(confirm).toContainText('its code is deleted from Seti')
  await confirm.getByRole('button', { name: 'Remove' }).click()
  await expect(toasts(page).filter({ hasText: `Removed ${name}` })).toBeVisible()
  await expect(tool).toBeHidden()
  expect(await sharedTool(request, name)).toBeUndefined()
  const removed = await apiData<AuditPage>(request, '/audit?kind=shared_tool.removed&limit=1')
  expect(removed.events[0]).toMatchObject({ actor: 'user', subject_id: name })
})
