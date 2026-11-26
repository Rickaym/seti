import type { Page } from '@playwright/test'
import { type ContextPack, type ContextPackSummary, isClaudeRow, type MessagePage, type Task } from '@seti/shared'
import { settingsDialog, showSection } from './support/agent-settings.js'
import { SYSTEM_PROMPT_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique, waitForToastsToClear } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { newRole, removePacks } from './support/roles.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const made: { id: string }[] = []

test.afterEach(async ({ request }) => {
  await removePacks(request, made.splice(0))
})

async function ownRole(page: Page, prefix: string, line: string): Promise<ContextPack> {
  const role = await newRole(page.request, prefix, line)
  made.push(role)
  return role
}

async function startAgent(page: Page, pinned: boolean): Promise<Task> {
  const created = await page.request.post('/api/tasks', {
    data: { title: unique('Release lead'), prompt: 'Hi', sandbox: false },
  })
  expect(created.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await created.json()) as { data: Task }).data
  if (pinned) {
    await page.request.patch(`/api/tasks/${task.id}`, { data: { pinned: true } })
  }
  return task
}

const settings = async (page: Page) => {
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  return page.getByRole('dialog').getByLabel('Agent details')
}

const roleOf = async (page: Page, taskId: string) =>
  (await apiData<ContextPackSummary[]>(page.request, `/tasks/${taskId}/context-packs`)).find(
    (pack) => pack.kind === 'role',
  ) ?? null

async function promptReply(page: Page, taskId: string): Promise<string> {
  await page.request.post(`/api/tasks/${taskId}/messages`, { data: { prompt: SYSTEM_PROMPT_PROMPT } })
  let reply = ''
  await expect
    .poll(async () => {
      const { messages } = await apiData<MessagePage>(page.request, `/tasks/${taskId}/messages?limit=50`)
      const texts = messages.flatMap((row) =>
        isClaudeRow(row) && row.payload.type === 'assistant'
          ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      )
      reply = texts.findLast((text) => text.includes('# Seti guide') || text.includes('Your Seti workspace')) ?? ''
      return reply
    })
    .not.toBe('')
  return reply
}

test("a pinned agent takes one of the user's roles, switches to another, and its next turn reads it", async ({
  page,
}) => {
  const lead = await ownRole(page, 'Lead', 'you delegate the work.')
  const reviewer = await ownRole(page, 'Reviewer', 'you review PRs.')
  const task = await startAgent(page, true)
  await page.goto(`/#agents/${task.id}`)
  const details = await settings(page)
  const picker = details.getByRole('combobox', { name: 'Role' })
  await expect(picker).toHaveValue('')
  await expect(picker.locator('optgroup')).toHaveCount(0)
  await picker.selectOption({ label: lead.name })
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(picker).toHaveValue(lead.id)
  await expect(details.getByTestId('task-role')).toHaveText(lead.body.split('\n')[0] ?? '')
  await expect(details.getByRole('button', { name: 'Edit role' })).toBeVisible()
  expect((await roleOf(page, task.id))?.name).toBe(lead.name)

  await picker.selectOption({ label: reviewer.name })
  await expect.poll(async () => (await roleOf(page, task.id))?.name).toBe(reviewer.name)
  await page.keyboard.press('Escape')

  const reply = await promptReply(page, task.id)
  const at = (text: string) => reply.indexOf(text)
  expect(at('## Your role\n')).toBeGreaterThan(at('# Seti guide'))
  expect(reply).toContain(reviewer.body)
  expect(reply).not.toContain(lead.body)
})

test('a new role from the picker is a role pack linked to the agent, edited on the Context page', async ({ page }) => {
  const task = await startAgent(page, false)
  await page.goto(`/#agents/${task.id}`)
  const details = await settings(page)
  await details.getByRole('combobox', { name: 'Role' }).selectOption({ label: 'New role...' })

  const dialog = page.getByRole('dialog', { name: `New role for ${task.title}` })
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(`${task.title} role`)
  const field = dialog.getByRole('textbox', { name: 'Role content' })
  await expect(field).toHaveValue('')
  await expect(dialog).not.toContainText('Start from')
  await field.fill('Release owner: you own the release train.\n- Cut the tag on Fridays.')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(dialog).toBeHidden()
  const linked = await roleOf(page, task.id)
  expect(linked?.name).toBe(`${task.title} role`)
  made.push({ id: linked?.id ?? '' })

  const again = await settings(page)
  await expect(again.getByTestId('task-role')).toHaveText(
    `${task.title} role: Release owner: you own the release train.`,
  )
  await again.getByRole('button', { name: 'Edit role' }).click()
  await expect(page).toHaveURL(new RegExp(`#context/pack:${linked?.id ?? ''}$`))
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: `${task.title} role`, level: 2 })).toBeVisible()
  await expect(main.getByRole('switch')).toBeHidden()
  await main.getByLabel('Role content').fill('Release owner: you own the release train.\n- Cut the tag on Mondays.')
  await page.keyboard.press('Control+s')
  await expect(page.getByText('unsaved', { exact: true })).toBeHidden()
  expect(await promptReply(page, task.id)).toContain('- Cut the tag on Mondays.')
})

test('None removes the role and leaves the role pack for others', async ({ page }) => {
  const lead = await ownRole(page, 'Lead', 'you delegate the work.')
  const task = await startAgent(page, false)
  await page.request.put(`/api/tasks/${task.id}/role`, { data: { pack_id: lead.id } })
  await page.goto(`/#agents/${task.id}`)
  const picker = (await settings(page)).getByRole('combobox', { name: 'Role' })
  await expect(picker).toHaveValue(lead.id)
  await waitForToastsToClear(page)
  await picker.selectOption({ label: 'None' })
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect.poll(async () => roleOf(page, task.id)).toBeNull()
  const packs = await apiData<ContextPack[]>(page.request, '/context/packs')
  expect(packs.some((pack) => pack.id === lead.id)).toBe(true)
  await page.keyboard.press('Escape')
  expect(await promptReply(page, task.id)).not.toContain('## Your role')
})

test('the palette opens the role picker, and the access dialog leaves roles out', async ({ page }) => {
  const watcher = await ownRole(page, 'Watcher', 'you watch CI.')
  const task = await startAgent(page, false)
  await page.goto(`/#agents/${task.id}`)
  await expect(page.getByRole('main').getByRole('heading', { name: task.title, level: 2 })).toBeVisible()

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>change role')
  await expect(palette.getByRole('option', { name: /Change role/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog').getByLabel('Agent details').getByRole('combobox', { name: 'Role' })
  await expect(picker).toBeFocused()
  await picker.selectOption({ label: watcher.name })
  await expect.poll(async () => (await roleOf(page, task.id))?.name).toBe(watcher.name)

  await showSection(settingsDialog(page), 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const packs = access.getByRole('region', { name: 'Context packs' })
  await expect(packs.getByRole('switch', { name: 'Seti guide' })).toBeVisible()
  await expect(packs).not.toContainText(watcher.name)
})
