import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { AGENT_COLOR_PRESETS, type AuditPage, type StartAgentInput, type Task, type TaskAccessView } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { addScratchRepos, apiData, expect, removeRepos, test } from './support/fixtures.js'

const main = (page: Page) => page.getByRole('main')
const message = (page: Page) => page.getByLabel('Message')

/** SSH hosts and AWS the agent has. */
async function grantedAccess(request: APIRequestContext, id: string): Promise<string[]> {
  const view = await apiData<TaskAccessView>(request, `/tasks/${id}/access`)
  return view.items.filter((item) => item.enabled && (item.kind === 'ssh' || item.kind === 'aws')).map((i) => i.id)
}

async function setName(request: APIRequestContext, name: string): Promise<void> {
  expect((await request.put('/api/user', { data: { name } })).ok()).toBe(true)
}

async function start(page: Page, text: string): Promise<string> {
  await message(page).fill(text)
  await message(page).press('Enter')
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  return new URL(page.url()).hash.split('/')[1] ?? ''
}

/** Leaves the agent's page first, so it does not ask for the deleted agent. */
async function remove(page: Page, id: string): Promise<void> {
  await page.goto('/#agents')
  expect((await page.request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
}

test.beforeEach(async ({ request }) => {
  await setName(request, 'Ada')
})

test('the agents page opens on the start page, which greets the user', async ({ page }) => {
  await page.goto('/#agents')
  await expect(main(page).getByRole('heading', { name: 'Your move, Ada' })).toBeVisible()
  await expect(message(page)).toHaveAttribute('placeholder', 'What should the agent do?')
  await expect(message(page)).not.toBeFocused()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await main(page).getByRole('button', { name: 'New agent', exact: true }).click()
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(main(page).getByRole('heading', { name: 'Your move, Ada' })).toBeVisible()
})

test('the start page opens from another section, by address and from the sidebar', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sections' })
  const greeting = main(page).getByRole('heading', { name: 'Your move, Ada' })
  for (const hash of ['#agents/new', '#agents']) {
    await page.goto('/#context')
    await expect(main(page).getByRole('heading', { name: 'Context', level: 1 })).toBeVisible()
    await page.goto(`/${hash}`)
    await expect(page).toHaveURL(new RegExp(`${hash}$`))
    await expect(greeting).toBeVisible()
    await expect(message(page)).toBeEditable()
  }

  await page.goto('/#context')
  await sidebar.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(/#agents$/)
  await expect(greeting).toBeVisible()
  await main(page).getByRole('button', { name: 'New agent', exact: true }).click()
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(message(page)).toBeEditable()
})

test('a draft typed on the agents page carries over to the new agent shortcut', async ({ page }) => {
  await page.goto('/#agents')
  await message(page).fill('Draft from the agents page')
  await page.getByRole('heading', { name: 'Your move, Ada' }).click()
  await page.keyboard.press('Alt+n')
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(message(page)).toHaveValue('Draft from the agents page')
  await message(page).fill('')
})

test('an agent starts straight from the agents page, in a preset colour', async ({ page, request }) => {
  await page.goto('/#agents')
  const id = await start(page, 'planner down: start from the agents page')
  await expect(main(page).getByRole('heading', { name: 'Planner down: start from the agents page' })).toBeVisible()
  const { color } = await apiData<Task>(request, `/tasks/${id}`)
  expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(color)
  await expect(page.locator(`[data-task-id="${id}"] button`)).toHaveAttribute('data-agent-color', color ?? '')
  await remove(page, id)
})

test('the Sandbox switch starts one agent outside the sandbox, then turns back on', async ({ page, request }) => {
  await page.goto('/#agents')
  const sandbox = main(page).getByRole('button', { name: 'Sandbox', exact: true })
  await expect(sandbox).toHaveAttribute('aria-pressed', 'true')
  await sandbox.click()
  await expect(sandbox).toHaveAttribute('aria-pressed', 'false')
  await expect(main(page).getByText('Starts outside the sandbox')).toBeVisible()
  const id = await start(page, 'planner down: check the vpn from the host')
  expect((await apiData<Task>(request, `/tasks/${id}`)).sandbox).toBe(false)
  await page.goto('/#agents')
  await expect(main(page).getByRole('button', { name: 'Sandbox', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await remove(page, id)
})

test('the name comes from Settings, General', async ({ page, request }) => {
  await page.goto('/#settings/general')
  const name = main(page).getByLabel('Your name')
  await expect(name).toHaveValue('Ada')
  await name.fill('Grace')
  await main(page).getByRole('region', { name: 'Name' }).getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await apiData<{ name: string }>(request, '/user')).name).toBe('Grace')
  await page.goto('/#agents/new')
  await expect(main(page).getByRole('heading', { name: 'Your move, Grace' })).toBeVisible()
})

test('the placeholder name "there" greets without a name', async ({ page, request }) => {
  await setName(request, 'there')
  await page.goto('/#agents/new')
  await expect(main(page).getByRole('heading', { name: 'Your move', exact: true })).toBeVisible()
  await expect(main(page)).not.toContainText('Your move, there')
})

test('the start button looks off until there is a message, then takes the primary colour', async ({ page }) => {
  await page.goto('/#agents/new')
  const send = main(page).getByRole('button', { name: 'Start agent' })
  const primary = main(page).getByRole('button', { name: 'New agent', exact: true })
  const look = async (locator: typeof send) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.backgroundColor, color: style.color, opacity: style.opacity }
    })
  const muted = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'bg-muted text-muted-foreground'
    document.body.append(probe)
    const style = getComputedStyle(probe)
    const colours = { background: style.backgroundColor, color: style.color }
    probe.remove()
    return colours
  })
  await expect(send).toBeDisabled()
  await expect.poll(async () => look(send)).toEqual({ ...muted, opacity: '1' })
  await message(page).fill('Tidy the README')
  await expect(send).toBeEnabled()
  const { background } = await look(primary)
  await expect.poll(async () => (await look(send)).background).toBe(background)
})

test('Enter starts a planned agent in its repo without a setup line', async ({ page, request }) => {
  const [api, web] = await addScratchRepos(request)
  const name = api.slug.split('/')[1] ?? ''
  await page.goto('/#agents/new')
  await expect(page.getByRole('button', { name: 'Start agent' })).toBeDisabled()
  await message(page).fill('First line')
  await message(page).press('Control+Enter')
  await expect(message(page)).toHaveValue('First line\n')

  const id = await start(page, `Fix the flaky test in ${name}`)
  await expect(main(page).getByRole('heading', { name: `Planned: Fix the flaky test in ${name}` })).toBeVisible()
  await expect(main(page)).toContainText(api.slug)
  await expect(main(page).getByLabel('Setup', { exact: true })).toBeHidden()
  await expect(main(page)).not.toContainText('Set up:')
  const task = await apiData<Task>(request, `/tasks/${id}`)
  expect(task).toMatchObject({ repo_id: api.id, worktree: true, sandbox: true })
  expect(await grantedAccess(request, id)).toEqual([])

  const events = await apiData<AuditPage>(request, '/audit?kind=task.created&limit=20')
  const created = events.events.find((event) => event.subject_id === id)
  expect(created?.detail).toMatchObject({ planner: 'model', planned: `repo ${api.slug} (worktree)` })
  await remove(page, id)
  await removeRepos(request, [api, web])
})

test('access the message does not clearly ask for is not given, and the agent settings say so', async ({
  page,
  request,
}) => {
  await page.goto('/#agents/new')
  const id = await start(page, 'Look at why the cloud server is slow')
  await expect(main(page).getByRole('heading', { name: 'Planned: Look at why the cloud server is slow' })).toBeVisible()
  await expect(main(page).getByLabel('Setup', { exact: true })).toHaveCount(0)
  await expect(main(page)).not.toContainText('Not given')
  expect(await apiData<Task>(request, `/tasks/${id}`)).toMatchObject({ sandbox: true })
  expect(await grantedAccess(request, id)).toEqual([])

  const details = await openAgentSettings(page, 'Access')
  const held = details.getByRole('list', { name: 'Held back' })
  await expect(held.getByRole('listitem').filter({ hasText: /^SSH server: / })).toHaveCount(1)
  await expect(held.getByRole('listitem').filter({ hasText: /^AWS: / })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await remove(page, id)
})

test('a planner that fails still starts the agent with defaults and a title from the message', async ({ page }) => {
  await page.goto('/#agents/new')
  const id = await start(page, 'planner down: sort the reading list')
  await expect(main(page).getByRole('heading', { name: 'Planner down: sort the reading list' })).toBeVisible()
  await expect(main(page)).not.toContainText('the planner did not answer')
  const details = await openAgentSettings(page, 'Session')
  await expect(details.getByLabel('Planner', { exact: true })).toContainText(/^Started with the defaults/)
  await page.keyboard.press('Escape')
  await remove(page, id)
})

test('a recent repo chip pins the agent to that repo', async ({ page, request }) => {
  const [api, web] = await addScratchRepos(request)
  const db = openSeedDb()
  const seeded = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(seeded, 'E2E recent repo', paths.home, at)
  await db.close()
  expect((await request.post(`/api/tasks/${seeded}/repos`, { data: { repo_id: api.id } })).ok()).toBe(true)

  const sent: StartAgentInput[] = []
  await page.route('**/api/tasks/start', async (route) => {
    sent.push(route.request().postDataJSON() as StartAgentInput)
    await route.fulfill({ json: { data: { id: 'e2e-intercepted' }, meta: {} } })
  })
  await page.goto('/#agents/new')
  const chip = page.getByRole('group', { name: 'Recent repos' }).getByRole('button', { name: api.slug })
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await message(page).fill('Bump the dependencies')
  await message(page).press('Enter')
  await expect(page).toHaveURL(/#agents\/e2e-intercepted$/)
  const { workspace_id } = await apiData<Task>(request, `/tasks/${seeded}`)
  expect(sent).toEqual([
    { prompt: 'Bump the dependencies', repo_ids: [api.id], workspace_id, client_id: expect.any(String) },
  ])
  await page.unroute('**/api/tasks/start')
  await remove(page, seeded)
  await removeRepos(request, [api, web])
})
