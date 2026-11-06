import { randomUUID } from 'node:crypto'
import type { ContextPack, ContextPackSummary } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the EA cog fits a phone with its role and context packs', async ({ page, request }) => {
  test.setTimeout(60_000)
  const name = `Phone pack ${randomUUID().slice(0, 6)}`
  const response = await request.post('/api/context/packs', { data: { name, description: '', body: 'Phone facts.' } })
  expect(response.ok()).toBe(true)
  const pack = ((await response.json()) as { data: ContextPack }).data
  try {
    await page.goto('/#ea')
    await page.getByRole('main').getByRole('button', { name: 'EA settings' }).tap()
    const panel = page.locator('dl[aria-label="EA settings"]')
    await expect(panel.getByRole('combobox', { name: 'Role' })).toBeVisible()
    await expectFitsPhone(page, 'EA settings with Role and Context')
    await panel.getByRole('combobox', { name: 'Role' }).selectOption({ label: 'Reviewer' })
    await expect(panel.getByTestId('task-role')).toContainText('Reviewer')
    await panel.getByRole('button', { name: 'Edit EA context packs' }).tap()
    const dialog = page.getByRole('dialog', { name: 'Context packs of the EA' })
    await dialog.getByRole('switch', { name }).tap()
    await expect(dialog.getByRole('switch', { name })).toBeChecked()
    await expectFitsPhone(page, 'EA context packs dialog')
    const linked = await apiData<ContextPackSummary[]>(request, '/ea/context-packs')
    expect(linked.map((summary) => summary.name)).toEqual(['Reviewer', name])
  } finally {
    await request.put('/api/ea/role', { data: { pack_id: null } })
    await request.put('/api/ea/context-packs', { data: { pack_ids: [] } })
    await request.delete(`/api/context/packs/${pack.id}`)
  }
})
