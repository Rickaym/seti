import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { codexOff } from './support/codex.js'
import { continueOnPicker, seedIdleCodexAgent } from './support/continue-on.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { SESSION_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a Codex agent continues on Claude Code from its settings, keeping its conversation', async ({
  page,
  request,
}) => {
  const title = unique('Move me')
  const id = await seedIdleCodexAgent(title)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page)
  const picker = continueOnPicker(page)
  await expect(picker.locator('optgroup')).toHaveCount(1)
  await expect(picker.locator('optgroup')).toHaveAttribute('label', 'Claude Code')
  await picker.selectOption({ label: 'Default' })

  const dialog = page.getByRole('dialog', { name: 'Continue on Claude Code' })
  await expect(dialog).toContainText('The conversation stays here.')
  await expect(dialog).toContainText('gets a brief of its work with its next message')
  await expect(dialog).toContainText('Background shells, processes and subagents end, and so does Bypass.')
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Continues on Claude Code' })).toBeVisible()
  await expect(transcript(page)).toContainText('Continued on Claude Code. The conversation stays here')
  const moved = await apiData<Task>(request, `/tasks/${id}`)
  expect(moved).toMatchObject({ title, runtime: 'claude', requested_model: null })

  const main = page.getByRole('main')
  await main.getByRole('combobox', { name: 'Reply' }).fill(`Now, ${SESSION_PROMPT}?`)
  await main.getByRole('combobox', { name: 'Reply' }).press('Enter')
  await expect(transcript(page)).toContainText('resumed none')
})

test('a Claude Code agent shows no picker while no other runtime is on', async ({ page, request }) => {
  await codexOff(request)
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique('Only Claude'), paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page)
  await expect(page.getByRole('button', { name: 'Restart session' })).toBeVisible()
  await expect(continueOnPicker(page)).toHaveCount(0)
})
