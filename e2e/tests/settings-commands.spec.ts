import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { seedCodexAgent } from './support/codex.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique(title), paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

/** Leaves a draft in the agent's reply box as a handed-over or restored draft arrives: not typed. */
async function leaveDraft(page: Page, taskId: string, text: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value)
    },
    [`seti.draft.task.${taskId}`, text] as const,
  )
}

const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const card = (page: Page, name: string) => page.getByRole('group', { name: `Command /${name}` })

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

test("the composer completes Seti's setting commands and runs Bypass through its own confirmation", async ({
  page,
  request,
}) => {
  const id = await seedAgent('Commands')
  await page.goto(`/#agents/${id}`)
  await reply(page).pressSequentially('/re')
  const list = page.getByRole('listbox', { name: 'Command suggestions' })
  await expect(list.getByRole('option', { name: /\/restart/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /\/rename/ })).toBeVisible()
  await shot(page, 'completion')

  await reply(page).fill('')
  await reply(page).pressSequentially('/bypass ')
  const bypass = card(page, 'bypass')
  await expect(bypass.getByRole('button', { name: '8 h' })).toBeVisible()
  await expect(bypass.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'picker')

  await bypass.getByRole('button', { name: '8 h' }).click()
  await expect(bypass).toContainText('Turn Bypass on')
  await expect(bypass).toContainText('runs every tool without asking for 8 hours')
  await shot(page, 'confirm')
  await bypass.getByRole('button', { name: 'Turn on' }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).not.toBeNull()
  await expect(reply(page)).toHaveValue('')

  await reply(page).pressSequentially('/bypass off')
  await reply(page).press('Enter')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).toBeNull()
})

test('a handed-over or pasted /archive waits for Run, then asks as Archive does', async ({
  page,
  context,
  request,
}) => {
  const id = await seedAgent('Handed over')
  await leaveDraft(page, id, '/archive')
  await page.goto(`/#agents/${id}`)
  await expect(reply(page)).toHaveValue('/archive')
  await reply(page).click()
  await expect(page.getByRole('listbox', { name: 'Command suggestions' })).toBeVisible()
  await reply(page).press('Enter')
  await expect(reply(page), 'Enter picks the command from the list').toHaveValue('/archive ')
  await reply(page).press('Enter')
  const archive = card(page, 'archive')
  await expect(archive).toContainText('This line was not typed here')
  await shot(page, 'run')
  await archive.getByRole('button', { name: 'Cancel' }).click()
  await expect(archive).toBeHidden()
  expect((await apiData<Task>(request, `/tasks/${id}`)).archived_at).toBeNull()

  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await reply(page).fill('')
  await page.evaluate(async () => navigator.clipboard.writeText('/archive'))
  await reply(page).press('ControlOrMeta+V')
  await expect(reply(page)).toHaveValue('/archive')
  await expect(page.getByRole('listbox', { name: 'Command suggestions' })).toBeHidden()
  await reply(page).press('Enter')
  await expect(archive).toContainText('This line was not typed here')
  await archive.getByRole('button', { name: 'Run' }).click()
  await expect(archive).toContainText('leaves the agent list')
  await archive.getByRole('button', { name: 'Archive' }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).archived_at).not.toBeNull()
})

test('a typed /settings opens the agent settings on the tab it names, and /rename renames', async ({
  page,
  request,
}) => {
  const id = await seedAgent('Opens')
  await page.goto(`/#agents/${id}`)
  await reply(page).pressSequentially('/settings team')
  await reply(page).press('Enter')
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('tablist', { name: 'Sections' }) })
  await expect(settings.getByRole('tab', { name: 'Team', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  const title = unique('Renamed')
  await reply(page).pressSequentially(`/rename ${title}`)
  await reply(page).press('Enter')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).title).toBe(title)
})

test('a Codex agent lists the setting commands its runtime takes and refuses the rest by name', async ({ page }) => {
  const id = await seedCodexAgent(unique('Codex commands'))
  await page.goto(`/#agents/${id}`)
  await reply(page).pressSequentially('/')
  const list = page.getByRole('listbox', { name: 'Command suggestions' })
  await expect(list.getByRole('option', { name: /\/mcp/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /\/bypass/ })).toHaveCount(0)
  await reply(page).pressSequentially('bypass ')
  await expect(card(page, 'bypass')).toContainText('/bypass is not on Codex agents')
})
