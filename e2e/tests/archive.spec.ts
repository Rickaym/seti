import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ArchivedTaskEntry, AuditPage, AutoArchiveStatus, MessagePage, TaskListEntry } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, nextApiResponse, test, toasts, unique } from './support/fixtures.js'

const ROWS = 240
const DAY = 24 * 60 * 60 * 1000
const RULE_DEFAULTS = { enabled: true, days: 3, delete_after_days: null, resume_after_restart: true }

const assistant = (text: string) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: 'seeded-session',
  uuid: randomUUID(),
})

/** An idle agent with a transcript long enough to page, written straight into the database. */
async function seedAgent(title: string, idleDays = 0): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date(Date.now() - idleDays * DAY).toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.run('BEGIN')
  await db.message(id, 'prompt', JSON.stringify({ text: `Start ${title}` }), at)
  for (let row = 1; row < ROWS; row++) {
    await db.message(id, 'sdk', JSON.stringify(assistant(`Archived step ${String(row)} of ${title}.`)), at)
  }
  await db.run('COMMIT')
  await db.close()
  return id
}

/** Links a PR that merged, so the agent shows COMPLETE. */
async function completeWith(id: string, url: string): Promise<void> {
  const db = openSeedDb()
  const at = new Date().toISOString()
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, url, at)
  await db.run(
    `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 0, ?)`,
    url,
    JSON.stringify({ state: 'merged' }),
    at,
  )
  await db.close()
}

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const activeIds = async (request: APIRequestContext) =>
  (await apiData<TaskListEntry[]>(request, '/tasks')).map((task) => task.id)
const archivedIds = async (request: APIRequestContext) =>
  (await apiData<ArchivedTaskEntry[]>(request, '/tasks/archived')).map((task) => task.id)

test('archives an agent from its settings, shows it read-only and restores it', async ({ page, request }) => {
  const title = unique('E2E archive me')
  const id = await seedAgent(title)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: title })).toBeVisible()
  await expect(transcript(page).getByText(`Archived step ${String(ROWS - 1)} of`)).toBeVisible()

  await expect(main.getByRole('button', { name: /^(Archive|Delete) agent$/ })).toHaveCount(0)
  await main.getByRole('button', { name: 'Agent settings' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive agent' })
  await expect(dialog).toContainText('Its transcript is compressed')
  await dialog.getByRole('button', { name: 'Archive' }).click()

  await expect(toasts(page).filter({ hasText: `Archived "${title}"` })).toBeVisible()
  const banner = main.getByRole('status', { name: 'Archived agent' })
  await expect(banner).toContainText(`${String(ROWS)} transcript rows`)
  await expect(banner).toContainText('Read-only until restored')
  await expect(main.getByText('archived', { exact: true }).first()).toBeVisible()
  await expect(main.getByRole('combobox', { name: 'Reply' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Agent settings' })).toHaveCount(0)
  await expect(transcript(page).getByText(`Archived step ${String(ROWS - 1)} of`)).toBeVisible()
  expect(await activeIds(request)).not.toContain(id)
  const [entry] = (await apiData<ArchivedTaskEntry[]>(request, '/tasks/archived')).filter((task) => task.id === id)
  expect(entry?.archive).toMatchObject({ rows: ROWS, codec: 'zstd', actor: 'user' })
  expect(entry?.archive.stored_bytes).toBeLessThan(entry?.archive.raw_bytes ?? 0)

  const earlier = nextApiResponse(page, 'GET', `/tasks/${id}/messages`)
  await transcript(page).getByRole('button', { name: 'Load earlier' }).dispatchEvent('click')
  expect(((await (await earlier).json()) as { data: MessagePage }).data.messages.length).toBeGreaterThan(0)
  await expect(transcript(page).getByText(`Start ${title}`)).toBeAttached()

  const list = main.getByRole('button', { name: new RegExp(title) })
  await expect(list).toHaveCount(0)
  await main.getByRole('button', { name: 'More list actions' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Archived' }).click()
  await expect(main.getByText('Archived, read-only')).toBeVisible()
  await expect(main.getByRole('button', { name: new RegExp(title) })).toBeVisible()

  await main.getByRole('button', { name: 'Restore' }).click()
  await expect(
    toasts(page).filter({ hasText: `Restored "${title}" with ${String(ROWS)} transcript rows` }),
  ).toBeVisible()
  await expect(banner).toHaveCount(0)
  await expect(main.getByRole('combobox', { name: 'Reply' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Agent settings' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Delete agent' })).toHaveCount(0)
  await expect.poll(async () => activeIds(request)).toContain(id)
  expect(await archivedIds(request)).not.toContain(id)

  const audited = async () =>
    (await apiData<AuditPage>(request, `/audit?kind=task&q=${id}&limit=10`)).events.map((event) => event.kind)
  await expect.poll(audited).toEqual(['task.unarchived', 'task.archived'])
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('deletes an agent only once it is archived, after a destructive confirm', async ({ page, request }) => {
  const title = unique('E2E delete when archived')
  const id = await seedAgent(title)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: title })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Delete agent' })).toHaveCount(0)
  await main.getByRole('button', { name: 'Agent settings' }).click()
  const settings = page.getByRole('dialog')
  await expect(settings.getByRole('button', { name: /Delete/ })).toHaveCount(0)
  await settings.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('dialog', { name: 'Archive agent' }).getByRole('button', { name: 'Archive' }).click()
  await expect(main.getByRole('status', { name: 'Archived agent' })).toBeVisible()

  await main.getByRole('button', { name: 'Delete agent' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete agent' })
  await expect(confirm).toContainText('cannot be restored')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
  expect(await archivedIds(request)).toContain(id)

  await main.getByRole('button', { name: 'Delete agent' }).click()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/#agents$/)
  await expect.poll(async () => archivedIds(request)).not.toContain(id)
  expect(await activeIds(request)).not.toContain(id)
})

test.describe('the auto archive rule', () => {
  test.afterEach(async ({ request }) => {
    await request.put('/api/archive/settings', { data: RULE_DEFAULTS })
  })

  test('shows what it would archive, saves its days and archives on demand', async ({ page, request }) => {
    expect((await request.put('/api/archive/settings', { data: { enabled: false, days: 3 } })).ok()).toBe(true)
    const title = unique('E2E done long ago')
    const id = await seedAgent(title, 5)
    await completeWith(id, `https://github.com/e2e/api/pull/${String(Date.now() % 100_000)}`)

    await page.goto('/#settings/agents')
    const card = page.getByRole('main').getByRole('region', { name: 'Archive' })
    const rule = card.getByRole('switch', { name: 'Auto archive' })
    const days = card.getByLabel('Days idle')
    await expect(rule).not.toBeChecked()
    await expect(days).toHaveValue('3')
    await expect(card).toContainText(title)

    await days.fill('10')
    await expect(card).not.toContainText(title)
    await days.fill('4')
    await expect(card).toContainText(title)
    const saved = nextApiResponse(page, 'PUT', '/archive/settings')
    await card.getByRole('button', { name: 'Save' }).click()
    expect((await saved).ok()).toBe(true)
    await expect(toasts(page).filter({ hasText: 'Auto archive saved' })).toBeVisible()

    await card.getByRole('button', { name: 'Archive now' }).click()
    await page.getByRole('dialog', { name: 'Archive now' }).getByRole('button', { name: 'Archive' }).click()
    await expect(toasts(page).filter({ hasText: /Archived \d+ agents?/ })).toBeVisible()
    await expect.poll(async () => archivedIds(request)).toContain(id)
    await expect(card).not.toContainText(title)
    await expect(card.getByRole('button', { name: 'Archive now' })).toBeDisabled()

    await rule.click()
    await card.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await apiData<AutoArchiveStatus>(request, '/archive/settings')).settings)
      .toMatchObject({ enabled: true, days: 4 })
    const audit = await apiData<AuditPage>(request, `/audit?kind=task.archived&q=${id}&limit=5`)
    expect(audit.events[0]?.summary).toContain('(COMPLETE and idle 4+ days)')
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('turns on deleting archived agents and scans for stale folders', async ({ page, request }) => {
    await page.goto('/#settings/agents')
    const card = page.getByRole('main').getByRole('region', { name: 'Archive' })
    const deleting = card.getByRole('switch', { name: 'Delete archived agents' })
    const days = card.getByLabel('Days archived')
    await expect(deleting).not.toBeChecked()
    await expect(days).toBeDisabled()
    await deleting.click()
    await days.fill('45')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(async () => (await apiData<AutoArchiveStatus>(request, '/archive/settings')).settings)
      .toMatchObject({ delete_after_days: 45 })

    const stale = page.getByRole('main').getByRole('region', { name: 'Stale folders' })
    const scanned = nextApiResponse(page, 'GET', '/archive/stale-folders')
    await stale.getByRole('button', { name: 'Scan' }).click()
    expect((await scanned).ok()).toBe(true)
    await expect(stale.getByRole('button', { name: /^Delete \d+$/ })).toBeVisible()
    await expect(stale.getByRole('button', { name: 'Rescan' })).toBeVisible()
  })

  test('turns Resume after restart off and on without touching the rule', async ({ page, request }) => {
    await page.goto('/#settings/agents')
    const resume = page
      .getByRole('main')
      .getByRole('region', { name: 'Restarts' })
      .getByRole('button', { name: 'Resume' })
    await expect(resume).toHaveAttribute('aria-pressed', 'true')
    const saved = nextApiResponse(page, 'PUT', '/archive/settings')
    await resume.click()
    expect((await saved).ok()).toBe(true)
    await expect(resume).toHaveAttribute('aria-pressed', 'false')
    expect((await apiData<AutoArchiveStatus>(request, '/archive/settings')).settings).toMatchObject({
      ...RULE_DEFAULTS,
      resume_after_restart: false,
    })
    await page.reload()
    await expect(resume).toHaveAttribute('aria-pressed', 'false')
    await resume.click()
    await expect(resume).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(async () => (await apiData<AutoArchiveStatus>(request, '/archive/settings')).settings.resume_after_restart)
      .toBe(true)
  })
})
