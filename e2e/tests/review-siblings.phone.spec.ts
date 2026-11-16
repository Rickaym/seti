import type { AgentPermissions, PermissionPolicy } from '@seti/shared'
import { seedIdleAgent } from './support/agent-chrome.js'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { chatServer, mockChatServer, removeChatRules } from './support/review-coverage.js'

test('the review checklist fits a phone and adds the chosen rules with taps', async ({ page, request }) => {
  const server = chatServer()
  await mockChatServer(page, server)
  try {
    await page.goto('/#settings/permissions')
    const rules = page.getByRole('region', { name: 'Global rules' })
    await rules.getByRole('combobox', { name: 'Rule action' }).selectOption('review')
    await rules.getByRole('textbox', { name: 'New rule' }).fill(server.tool('send_message'))
    await rules.getByRole('button', { name: 'Add' }).tap()

    const dialog = page.getByRole('dialog', { name: `Review ${server.label}` })
    const upload = dialog.getByRole('checkbox', { name: 'complete_file_upload' })
    await expect(upload).toBeChecked()
    await expectFitsPhone(page, 'review checklist')
    const row = await dialog.getByRole('listitem').filter({ hasText: 'schedule_message' }).boundingBox()
    expect(row?.height ?? 0, 'a row is tall enough for a finger').toBeGreaterThanOrEqual(44)
    await dialog.getByRole('checkbox', { name: 'schedule_message' }).tap()
    await dialog.getByRole('button', { name: 'Add 2' }).tap()
    await expect(dialog).toHaveCount(0)

    const notice = rules.getByRole('list', { name: 'Review coverage' })
    await expect(notice).toContainText(`1 other ${server.label} tool can write or send and is not reviewed.`)
    await expectFitsPhone(page, 'review coverage notice')
    await notice.getByRole('button', { name: `Choose ${server.label} tools to review` }).tap()
    await dialog.getByRole('switch', { name: `Every tool of ${server.label}` }).tap()
    await expectFitsPhone(page, 'review checklist for the whole server')
    await dialog.getByRole('button', { name: 'Add', exact: true }).tap()
    await expect(notice).toHaveCount(0)
    const policy = await apiData<PermissionPolicy>(request, '/permissions')
    expect(policy.rules.map((rule) => rule.rule)).toEqual(
      expect.arrayContaining([server.tool('send_message'), server.tool('complete_file_upload'), server.rule]),
    )
  } finally {
    await removeChatRules(request, server)
  }
})

test("the checklist opens over an agent's settings on a phone", async ({ page }) => {
  const server = chatServer()
  const id = await seedIdleAgent(unique('Phone review siblings'))
  await mockChatServer(page, server, `/tasks/${id}/permissions`)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  await details.getByRole('combobox', { name: 'Rule action' }).selectOption('review')
  await details.getByRole('textbox', { name: 'New rule' }).fill(server.tool('send_message'))
  await details.getByRole('button', { name: 'Add', exact: true }).tap()

  const dialog = page.getByRole('dialog', { name: `Review ${server.label}` })
  await expect(dialog.getByRole('checkbox', { name: 'complete_file_upload' })).toBeChecked()
  await expectFitsPhone(page, "review checklist over an agent's settings")
  await dialog.getByRole('button', { name: 'Add 3' }).tap()
  await expect(dialog).toHaveCount(0)
  await expect(details.getByRole('list', { name: 'Review rules' }).getByRole('listitem')).toHaveCount(3)
  const permissions = await apiData<AgentPermissions>(page.request, `/tasks/${id}/permissions`)
  expect(permissions.own).toHaveLength(3)
})
