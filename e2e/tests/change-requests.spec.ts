import { randomUUID } from 'node:crypto'
import type { AuditPage, ChangeRequest, Connection, TaskAccessView } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { expectKeyStaysSecret, seedChangeRequest } from './support/change-requests.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'

test('a host request shows its exact change and is allowed for the agent with one click', async ({ page, request }) => {
  const change = { kind: 'allow_host', host: '*.fixtures.example.com', port: 443 }
  const { taskId, requestId, title } = await seedChangeRequest(change, 'Asks for access to *.fixtures.example.com:443')

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${taskId}"]`)
  await expect(row).toContainText('Asks for access to *.fixtures.example.com:443')
  await row.getByRole('button').first().click()
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText('Let this agent reach *.fixtures.example.com:443?')
  await expect(card).toContainText('The tests download fixtures from there.')
  await expect(card).toContainText('+ *.fixtures.example.com:443')
  await expect(card).toContainText('Wildcard: every subdomain of fixtures.example.com')
  await expect(card.getByRole('button', { name: 'This agent' })).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: 'All agents' }).click()
  await expect(card).toContainText('Let every agent reach')
  await card.getByRole('button', { name: 'This agent' }).click()
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)

  const access = await apiData<TaskAccessView>(request, `/tasks/${taskId}/access`)
  expect(access.hosts).toEqual(['*.fixtures.example.com:443'])
  expect(await apiData<ChangeRequest[]>(request, `/tasks/${taskId}/change-requests`)).toEqual([])
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.change_allowed&limit=1')
  expect(audit.events[0]).toMatchObject({ actor: 'user', subject_id: taskId, detail: { request_id: requestId } })
  await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
    'The user allowed you to reach *.fixtures.example.com:443',
  )

  await openAgentSettings(page, 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const dialog = page.getByRole('dialog', { name: `Access of ${title}` })
  const hosts = dialog.getByRole('region', { name: 'Own hosts' })
  await expect(hosts).toContainText('*.fixtures.example.com:443')
  await hosts.getByRole('button', { name: 'Remove *.fixtures.example.com:443' }).click()
  await expect(toasts(page).filter({ hasText: 'removed' })).toBeVisible()
  await expect(hosts).toHaveCount(0)
  expect((await apiData<TaskAccessView>(request, `/tasks/${taskId}/access`)).hosts).toEqual([])
})

test('a key request adds a connection to the agent credential, and its key is pasted later', async ({
  page,
  request,
}) => {
  const change = { kind: 'api_key', env: 'FIXTURE_KEY', hosts: ['api.fixtures.example.com'] }
  const { taskId } = await seedChangeRequest(change, 'Asks for an API key FIXTURE_KEY for api.fixtures.example.com')

  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText('Add the connection FIXTURE_KEY?')
  await expect(card).toContainText("This agent's credential")
  await expect(card.getByLabel('Key for FIXTURE_KEY')).toHaveValue('')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
    'The user added the connection FIXTURE_KEY',
  )
  const made = (await apiData<Connection[]>(request, '/connections')).find((entry) => entry.env === 'FIXTURE_KEY')
  expect(made).toMatchObject({ name: 'fixture_key', missing: ['value'], profiles: [{ id: 'default' }] })
  await request.delete(`/api/connections/${made?.id ?? ''}`)
})

test('a key pasted on the card adds the connection with its key in one click, and stays secret', async ({
  page,
  request,
}) => {
  const change = { kind: 'api_key', env: 'PASTED_KEY', hosts: ['api.pasted.example.com'] }
  const { taskId, requestId } = await seedChangeRequest(change, 'Asks for an API key PASTED_KEY')
  const key = `pasted-${randomUUID()}`

  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  const box = card.getByLabel('Key for PASTED_KEY')
  await expect(box).toHaveAttribute('type', 'password')
  await expect(box).toHaveAttribute('autocomplete', 'off')
  await box.fill(key)
  await card.getByRole('button', { name: 'Show key' }).click()
  await expect(box).toHaveAttribute('type', 'text')
  await card.getByRole('button', { name: 'Hide key' }).click()
  await expect(box).toHaveAttribute('type', 'password')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
    'The user added the connection PASTED_KEY with its key',
  )

  const made = (await apiData<Connection[]>(request, '/connections')).find((entry) => entry.env === 'PASTED_KEY')
  expect(made).toMatchObject({ missing: [], slots: [{ slot: 'value', set: true }], profiles: [{ id: 'default' }] })
  await expectKeyStaysSecret(page, request, { taskId, requestId, key })
  await request.delete(`/api/connections/${made?.id ?? ''}`)
})

test('a denied request tells the agent and changes nothing', async ({ page, request }) => {
  const change = { kind: 'allow_host', host: 'denied.example.com', port: 443 }
  const { taskId } = await seedChangeRequest(change, 'Asks for access to denied.example.com:443')
  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await card.getByRole('button', { name: 'Deny' }).click()
  await expect(card).toHaveCount(0)
  expect((await apiData<TaskAccessView>(request, `/tasks/${taskId}/access`)).hosts).toEqual([])
  await expect(page.getByRole('main').locator('[data-input="seti-denied"]')).toContainText(
    'The user denied your request for access to denied.example.com:443',
  )
})
