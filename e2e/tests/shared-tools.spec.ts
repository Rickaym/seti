import type { AuditPage, SharedToolCode } from '@seti/shared'
import { EA_HEADERS } from './support/env.js'
import { apiData, expect, test, toasts, waitForToastsToClear } from './support/fixtures.js'
import { seedToolProposal, sharedTool, TOOL_DESCRIPTION } from './support/shared-tools.js'

const FIRST = '#!/usr/bin/env python3\nimport sys\nprint("invoices of", sys.argv[1])\n'
const SECOND = '#!/usr/bin/env python3\nimport sys\nprint("open invoices of", sys.argv[1])\n'

test('a proposed tool shows its code, is published on Allow, updated, turned off and removed', async ({
  page,
  request,
}) => {
  const { taskId, requestId, title, name, hash } = await seedToolProposal(FIRST)

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${taskId}"]`)
  await expect(row).toContainText(`Asks for the shared tool ${name}`)
  await row.getByRole('button').first().click()
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText(`Publish the shared tool ${name}?`)
  await expect(card).toContainText(TOOL_DESCRIPTION)
  await expect(card).toContainText('Other agents keep asking me to look invoices up for them.')
  await expect(card.getByRole('list', { name: 'Needs' })).toContainText('BILLING_KEY for api.billing.example.com')
  await expect(card).toContainText(`invoices.py, sha256 ${hash.slice(0, 12)}`)
  await expect(card.getByRole('region', { name: `Code of ${name}` })).toHaveText(FIRST)
  await expect(card).toContainText('Every sandboxed agent whose credential has BILLING_KEY will be able to run this')
  await expect(card.getByRole('region', { name: `Changes to ${name}` })).toHaveCount(0)

  const refused = await request.post(`/api/tasks/${taskId}/change-requests/${requestId}`, {
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
  expect(await sharedTool(request, name)).toMatchObject({ sha256: hash, enabled: true, proposer_title: title })
  const audit = await apiData<AuditPage>(request, '/audit?kind=shared_tool.allowed&limit=1')
  expect(audit.events[0]).toMatchObject({ actor: 'user', subject_id: name, detail: { sha256: hash, task_id: taskId } })
  expect(JSON.stringify(audit.events[0])).not.toContain('invoices of')

  const live = await apiData<SharedToolCode>(request, `/shared-tools/${name}`)
  const update = await seedToolProposal(SECOND, live)
  await page.goto(`/#agents/${update.taskId}`)
  await expect(card).toContainText(`Update the shared tool ${name}?`)
  await expect(card).toContainText(`Replaces the published ${name}`)
  const changes = card.getByRole('region', { name: `Changes to ${name}` })
  await expect(changes.locator('[data-diff="del"]')).toHaveText('-print("invoices of", sys.argv[1])')
  await expect(changes.locator('[data-diff="add"]')).toHaveText('+print("open invoices of", sys.argv[1])')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(await sharedTool(request, name)).toMatchObject({ sha256: update.hash, proposer_title: update.title })

  await page.goto('/#settings/plugins')
  const main = page.getByRole('main')
  const tool = main.locator(`[data-shared-tool="${name}"]`)
  await expect(tool).toContainText(TOOL_DESCRIPTION)
  await expect(tool).toContainText(`Proposed by ${update.title}`)
  await expect(tool).toContainText('BILLING_KEY for api.billing.example.com')
  await tool.getByRole('button', { name: `Code of ${name}` }).click()
  const dialog = page.getByRole('dialog', { name: `Code of ${name}` })
  await expect(dialog.getByRole('region', { name: `Code of ${name}` })).toHaveText(SECOND)
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
  await expect(tool).toBeHidden()
  expect(await sharedTool(request, name)).toBeUndefined()
  const removed = await apiData<AuditPage>(request, '/audit?kind=shared_tool.removed&limit=1')
  expect(removed.events[0]).toMatchObject({ actor: 'user', subject_id: name })
})
