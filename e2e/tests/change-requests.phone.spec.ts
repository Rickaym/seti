import { randomUUID } from 'node:crypto'
import type { Connection, TaskAccessView } from '@seti/shared'
import { expectKeyStaysSecret, seedChangeRequest } from './support/change-requests.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a change request fits the phone and is allowed with a tap', async ({ page, request }) => {
  const change = { kind: 'allow_host', host: 'phone.fixtures.example.com', port: 8443 }
  const { taskId } = await seedChangeRequest(change, 'Asks for access to phone.fixtures.example.com:8443')

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${taskId}"]`)
  await expect(row).toContainText('Asks for access to phone.fixtures.example.com:8443')
  await row.getByRole('button').first().tap()
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText('+ phone.fixtures.example.com:8443')
  await card.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'change request')
  await card.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(card).toHaveCount(0)
  expect((await apiData<TaskAccessView>(request, `/tasks/${taskId}/access`)).hosts).toEqual([
    'phone.fixtures.example.com:8443',
  ])
})

test('a key pasted on the phone adds the connection with its key in one tap', async ({ page, request }) => {
  const change = { kind: 'api_key', env: 'PHONE_PASTED_KEY', hosts: ['api.phone.example.com'] }
  const { taskId, requestId } = await seedChangeRequest(change, 'Asks for an API key PHONE_PASTED_KEY')
  const key = `phone-${randomUUID()}`

  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  const box = card.getByLabel('Key for PHONE_PASTED_KEY')
  const toggle = card.getByRole('button', { name: 'Show key' })
  await card.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'key request')
  for (const target of [box, toggle]) {
    expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  await box.fill(key)
  await toggle.tap()
  await expect(box).toHaveAttribute('type', 'text')
  await card.getByRole('button', { name: 'Hide key' }).tap()
  await expect(box).toHaveAttribute('type', 'password')
  await card.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(card).toHaveCount(0)

  const made = (await apiData<Connection[]>(request, '/connections')).find((entry) => entry.env === 'PHONE_PASTED_KEY')
  expect(made).toMatchObject({ missing: [], profiles: [{ id: 'default' }] })
  await expectKeyStaysSecret(page, request, { taskId, requestId, key })
  await request.delete(`/api/connections/${made?.id ?? ''}`)
})
