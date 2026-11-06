import fs from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import type { AuditPage, Repo, Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { projectDir, SEEDED } from './support/sessions.js'

const SEEDED_DOCS_PR = 'https://github.com/e2e/docs/pull/4'
const created: string[] = []
let repo: Repo | null = null

test.beforeAll(async ({ request }) => {
  const slug = `e2e/${unique('imports')}`
  const res = await request.post('/api/repos', { data: { slug, path: paths.checkout, base_branch: 'main' } })
  expect(res.ok()).toBe(true)
  repo = ((await res.json()) as { data: Repo }).data
})

test.afterAll(async ({ request }) => {
  for (const id of created) {
    await request.delete(`/api/tasks/${id}`)
  }
  if (repo) {
    await request.delete(`/api/repos/${repo.id}`)
  }
})

async function openImport(page: Page): Promise<Locator> {
  await page.goto('/#agents')
  await page.getByRole('main').getByRole('button', { name: 'More list actions' }).click()
  await page.getByRole('menuitem', { name: 'Import sessions' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import sessions' })
  await expect(dialog).toBeVisible()
  return dialog
}

const sessionRow = (dialog: Locator, title: string) =>
  dialog.getByRole('list', { name: 'Sessions' }).getByRole('listitem').filter({ hasText: title })

async function taskBySource(page: Page, sourceId: string): Promise<Task> {
  const tasks = await apiData<Task[]>(page.request, '/tasks')
  const task = tasks.find((t) => t.source_session_id === sourceId)
  if (!task) {
    throw new Error(`No task was imported from ${sourceId}`)
  }
  created.push(task.id)
  return task
}

test('imports one terminal session with its history, PR and an imported marker', async ({ page }) => {
  const { login } = SEEDED
  const dialog = await openImport(page)
  await expect(sessionRow(dialog, login.title)).toBeVisible()
  await expect(sessionRow(dialog, SEEDED.laptop.title)).toContainText('folder missing')
  await expect(sessionRow(dialog, login.title)).toContainText(repo?.slug ?? '')

  await dialog.getByLabel('Search sessions').fill('login')
  await expect(sessionRow(dialog, SEEDED.notes.title)).toHaveCount(0)
  await sessionRow(dialog, login.title)
    .getByRole('button', { name: new RegExp(login.title) })
    .click()

  const detail = dialog.getByRole('region', { name: 'Session detail' })
  await expect(detail.getByRole('link', { name: 'app#12' })).toBeVisible()
  await expect(detail.getByText('created here')).toBeVisible()
  await expect(detail.getByRole('link', { name: 'docs#4' })).toBeVisible()
  const prs = detail.getByRole('group', { name: 'Pull requests' })
  await expect(prs.getByRole('checkbox', { name: 'app#12 (created in session)' })).toBeChecked()
  const docs = prs.getByRole('checkbox', { name: 'docs#4 (mentioned)' })
  await expect(docs).not.toBeChecked()
  await docs.click()
  await expect(detail.locator('dd').first()).toHaveText('5')
  await detail.getByLabel('Agent title').fill('E2E imported login')
  await detail.getByRole('button', { name: 'Import this session' }).click()

  await expect(dialog).toBeHidden()
  const task = await taskBySource(page, login.id)
  await expect(page).toHaveURL(new RegExp(`#agents/${task.id}$`))
  expect(task).toMatchObject({
    title: 'E2E imported login',
    cwd: paths.checkout,
    repo_id: repo?.id,
    pr_urls: [login.pr, SEEDED_DOCS_PR],
    status: 'idle',
  })
  expect(task.session_id).not.toBe(login.id)
  expect(fs.existsSync(`${projectDir(paths.checkout)}/${task.session_id ?? ''}.jsonl`)).toBe(true)

  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'E2E imported login' })).toBeVisible()
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(login.prompt)).toBeVisible()
  await expect(pane.getByText(login.reply)).toBeVisible()
  await expect(pane.getByTestId('tool-summary').getByText('gh pr create --fill', { exact: true })).toBeVisible()
  await openAgentSettings(page, 'Session')
  await expect(page.getByRole('definition').filter({ hasText: login.id })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(main.getByRole('group', { name: 'Pull request app#12' })).toBeVisible()
  await expect(main.getByRole('group', { name: 'Pull request docs#4' })).toBeVisible()
  await expect(main.getByRole('button', { name: /E2E imported login/ })).not.toContainText('#')

  const audit = await apiData<AuditPage>(page.request, '/audit?kind=task.imported&limit=5')
  expect(audit.events.find((e) => e.subject_id === task.id)?.detail).toMatchObject({
    source_session_id: login.id,
    session_id: task.session_id,
    pr_urls: [login.pr, SEEDED_DOCS_PR],
  })

  const again = await openImport(page)
  await expect(sessionRow(again, SEEDED.notes.title)).toBeVisible()
  await expect(sessionRow(again, login.title)).toHaveCount(0)
})

test('imports a few ticked sessions together after reviewing each one', async ({ page }) => {
  const { notes, laptop } = SEEDED
  const dialog = await openImport(page)
  const review = dialog.getByRole('button', { name: 'Review', exact: true })
  await expect(review).toBeDisabled()
  await sessionRow(dialog, notes.title).getByRole('checkbox').click()
  await sessionRow(dialog, laptop.title).getByRole('checkbox').click()
  await expect(dialog.getByText('2 selected')).toBeVisible()
  await review.click()

  const reviewDialog = page.getByRole('dialog', { name: 'Review 2 sessions' })
  const notesItem = reviewDialog.getByRole('listitem', { name: notes.title })
  const laptopItem = reviewDialog.getByRole('listitem', { name: laptop.title })
  const importButton = reviewDialog.getByRole('button', { name: 'Import 2 sessions' })
  await expect(laptopItem.getByText('Pick a repo to continue in')).toBeVisible()
  await expect(importButton).toBeDisabled()
  await expect(notesItem.getByRole('group', { name: 'Pull requests' })).toContainText('No pull requests found')

  await laptopItem.getByLabel('Continue in').click()
  await page.getByRole('option', { name: repo?.slug ?? '' }).click()
  await notesItem.getByLabel('Agent title').fill('E2E notes, continued')
  await expect(importButton).toBeEnabled()
  await importButton.click()

  await expect(reviewDialog).toBeHidden()
  const notesTask = await taskBySource(page, notes.id)
  const laptopTask = await taskBySource(page, laptop.id)
  await expect(page).toHaveURL(new RegExp(`#agents/${notesTask.id}$`))
  expect(notesTask).toMatchObject({ title: 'E2E notes, continued', cwd: paths.checkout, pr_urls: [] })
  expect(laptopTask).toMatchObject({ title: laptop.title, cwd: paths.checkout, repo_id: repo?.id })

  const list = page.getByRole('main').getByRole('button', { name: new RegExp(laptop.title) })
  await list.click()
  await expect(page.getByRole('region', { name: 'Transcript' }).getByText(laptop.reply)).toBeVisible()
})
