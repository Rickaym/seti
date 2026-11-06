import type { Page } from '@playwright/test'
import { BUILTIN_ROLES, type ContextPack, type ContextPackSummary, type MessagePage, type Task } from '@seti/shared'
import { settingsDialog, showSection } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { SYSTEM_PROMPT_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique, waitForToastsToClear } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const role = (name: string) => BUILTIN_ROLES.find((entry) => entry.name === name) ?? { id: '', text: '' }
const LEAD = role('Lead')
const REVIEWER = role('Reviewer')

async function startAgent(page: Page, pinned: boolean): Promise<Task> {
  const created = await page.request.post('/api/tasks', {
    data: { title: unique('Release lead'), prompt: 'Hi', cwd: paths.checkout, sandbox: false },
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
        row.kind === 'sdk' && row.payload.type === 'assistant'
          ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      )
      reply = texts.findLast((text) => text.includes('# Seti guide') || text.includes('Your Seti workspace')) ?? ''
      return reply
    })
    .not.toBe('')
  return reply
}

test('a pinned agent gets the built-in Lead role in one click and its next turn reads it', async ({ page }) => {
  const task = await startAgent(page, true)
  await page.goto(`/#agents/${task.id}`)
  const details = await settings(page)
  const picker = details.getByRole('combobox', { name: 'Role' })
  await expect(details).toContainText('Pinned agents work best with a role')
  await expect(picker).toHaveValue('')
  await details.getByRole('button', { name: 'Lead', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(picker).toHaveValue(LEAD.id)
  await expect(details.getByTestId('task-role')).toHaveText(LEAD.text.split('\n')[0] ?? '')
  await expect(details).not.toContainText('Pinned agents work best with a role')
  await expect(details.getByRole('button', { name: 'Duplicate role to edit' })).toBeVisible()
  expect((await roleOf(page, task.id))?.name).toBe('Lead')

  await picker.selectOption({ label: 'Reviewer' })
  await expect.poll(async () => (await roleOf(page, task.id))?.name).toBe('Reviewer')
  await page.keyboard.press('Escape')

  const reply = await promptReply(page, task.id)
  const at = (text: string) => reply.indexOf(text)
  expect(at('## Your role\n')).toBeGreaterThan(at('# Seti guide'))
  expect(reply).toContain(REVIEWER.text)
  expect(reply).not.toContain(LEAD.text)
})

test('a new role from the picker is a role pack linked to the agent, edited on the Context page', async ({ page }) => {
  const task = await startAgent(page, false)
  await page.goto(`/#agents/${task.id}`)
  const details = await settings(page)
  await expect(details).not.toContainText('Pinned agents work best with a role')
  await details.getByRole('combobox', { name: 'Role' }).selectOption({ label: 'New role...' })

  const dialog = page.getByRole('dialog', { name: `New role for ${task.title}` })
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(`${task.title} role`)
  const field = dialog.getByRole('textbox', { name: 'Role content' })
  await dialog.getByRole('button', { name: 'Reviewer' }).click()
  await expect(field).toHaveValue(REVIEWER.text)
  await field.fill('Release owner: you own the release train.\n- Cut the tag on Fridays.')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(dialog).toBeHidden()
  const linked = await roleOf(page, task.id)
  expect(linked?.name).toBe(`${task.title} role`)

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

test('duplicating a built-in role links the copy, None removes the role', async ({ page }) => {
  const task = await startAgent(page, false)
  await page.request.put(`/api/tasks/${task.id}/role`, { data: { pack_id: LEAD.id } })
  await page.goto(`/#agents/${task.id}`)
  const details = await settings(page)
  await details.getByRole('button', { name: 'Duplicate role to edit' }).click()
  await expect(page).toHaveURL(/#context\/pack:[0-9a-f-]{36}$/)
  const copy = await roleOf(page, task.id)
  expect(copy?.name).toMatch(/^Lead \(copy( \d+)?\)$/)
  await expect(page.getByRole('main').getByLabel('Role content')).toHaveValue(LEAD.text)

  await page.goto(`/#agents/${task.id}`)
  const picker = (await settings(page)).getByRole('combobox', { name: 'Role' })
  await expect(picker).toHaveValue(copy?.id ?? '')
  await waitForToastsToClear(page)
  await picker.selectOption({ label: 'None' })
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect.poll(async () => roleOf(page, task.id)).toBeNull()
  const packs = await apiData<ContextPack[]>(page.request, '/context/packs')
  expect(packs.some((pack) => pack.id === copy?.id)).toBe(true)
  await page.keyboard.press('Escape')
  expect(await promptReply(page, task.id)).not.toContain('## Your role')
})

test('the palette opens the role picker, and the access dialog leaves roles out', async ({ page }) => {
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
  await picker.selectOption({ label: 'Watcher' })
  await expect.poll(async () => (await roleOf(page, task.id))?.name).toBe('Watcher')

  await showSection(settingsDialog(page), 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const packs = access.getByRole('region', { name: 'Context packs' })
  await expect(packs.getByRole('switch', { name: 'Seti guide' })).toBeVisible()
  await expect(packs).not.toContainText('Watcher')
})
