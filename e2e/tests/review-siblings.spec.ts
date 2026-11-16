import type { Page } from '@playwright/test'
import type { AgentPermissions, PermissionPolicy } from '@seti/shared'
import { seedIdleAgent } from './support/agent-chrome.js'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { chatServer, mockChatServer, removeChatRules } from './support/review-coverage.js'

const rules = (page: Page) => page.getByRole('region', { name: 'Global rules' })

const reviewRules = async (page: Page) =>
  (await apiData<PermissionPolicy>(page.request, '/permissions')).rules
    .filter((rule) => rule.behavior === 'review')
    .map((rule) => rule.rule)

async function typeReviewRule(page: Page, rule: string): Promise<void> {
  await rules(page).getByRole('combobox', { name: 'Rule action' }).selectOption('review')
  await rules(page).getByRole('textbox', { name: 'New rule' }).fill(rule)
  await rules(page).getByRole('button', { name: 'Add' }).click()
}

test('a review rule for one tool offers the other writing tools of its server', async ({ page, request }) => {
  const server = chatServer()
  await mockChatServer(page, server)
  try {
    await page.goto('/#settings/permissions')
    await typeReviewRule(page, server.tool('send_message'))

    const dialog = page.getByRole('dialog', { name: `Review ${server.label}` })
    await expect(dialog).toContainText(`${server.label} marks 4 of its tools as not read-only.`)
    const list = dialog.getByRole('list', { name: `${server.label} tools` })
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await expect(list.getByRole('checkbox', { name: 'send_message' })).toBeChecked()
    await expect(list.getByRole('checkbox', { name: 'send_message' })).toBeDisabled()
    await expect(list.getByRole('checkbox', { name: 'complete_file_upload' })).toBeChecked()
    await expect(list.getByRole('checkbox', { name: 'schedule_message' })).toBeChecked()
    await expect(list.getByRole('checkbox', { name: 'rename_list' })).not.toBeChecked()
    expect(await reviewRules(page), 'nothing is added before the confirm').not.toContain(server.tool('send_message'))

    await list.getByRole('checkbox', { name: 'schedule_message' }).click()
    await dialog.getByRole('button', { name: 'Add 2' }).click()
    await expect(dialog).toHaveCount(0)
    const review = rules(page).getByRole('region', { name: 'Review' })
    await expect(review).toContainText(server.tool('send_message'))
    await expect(review).toContainText(server.tool('complete_file_upload'))
    await expect(review).not.toContainText(server.tool('schedule_message'))
    await expect(rules(page).getByRole('textbox', { name: 'New rule' })).toHaveValue('')

    const notice = rules(page).getByRole('list', { name: 'Review coverage' })
    await expect(notice).toContainText(`1 other ${server.label} tool can write or send and is not reviewed.`)
    await notice.getByRole('button', { name: `Choose ${server.label} tools to review` }).click()
    await expect(list.getByRole('checkbox', { name: 'send_message' })).toBeDisabled()
    await expect(list.getByRole('listitem').filter({ hasText: 'complete_file_upload' })).toContainText('Reviewed')
    await expect(list.getByRole('checkbox', { name: 'schedule_message' })).toBeChecked()
    await dialog.getByRole('switch', { name: `Every tool of ${server.label}` }).click()
    await expect(list).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(review).toContainText(server.rule)
    await expect(notice).toHaveCount(0)
    expect(await reviewRules(page)).toEqual(
      expect.arrayContaining([server.tool('send_message'), server.tool('complete_file_upload'), server.rule]),
    )
  } finally {
    await removeChatRules(request, server)
  }
})

test('a review rule for a server Seti has no tool list for is added as typed, with a line saying so', async ({
  page,
  request,
}) => {
  const server = chatServer()
  try {
    await page.goto('/#settings/permissions')
    await typeReviewRule(page, server.tool('send_message'))
    await expect(rules(page).getByRole('region', { name: 'Review' })).toContainText(server.tool('send_message'))
    await expect(rules(page).getByRole('status')).toContainText(
      `${server.label} is not connected, so Seti cannot list its other tools.`,
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await removeChatRules(request, server)
  }
})

test("an agent's own review rule offers the same checklist and adds rules for that agent only", async ({ page }) => {
  const server = chatServer()
  const id = await seedIdleAgent(unique('E2E review siblings'))
  await mockChatServer(page, server, `/tasks/${id}/permissions`)
  await page.goto(`/#agents/${id}`)
  const details = await openAgentSettings(page, 'Access')
  await details.getByRole('combobox', { name: 'Rule action' }).selectOption('review')
  await details.getByRole('textbox', { name: 'New rule' }).fill(server.tool('send_message'))
  await details.getByRole('button', { name: 'Add', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: `Review ${server.label}` })
  await expect(dialog.getByRole('checkbox', { name: 'complete_file_upload' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Add 3' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(details.getByRole('list', { name: 'Review rules' }).getByRole('listitem')).toHaveCount(3)
  await expect(details.getByRole('list', { name: 'Review coverage' })).toHaveCount(0)
  const permissions = await apiData<AgentPermissions>(page.request, `/tasks/${id}/permissions`)
  expect(permissions.own.map((rule) => rule.rule)).toEqual(
    expect.arrayContaining(['send_message', 'schedule_message', 'complete_file_upload'].map(server.tool)),
  )
  expect(permissions.rules.filter((rule) => rule.rule.startsWith(server.rule))).toEqual([])
})
