import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { AuditPage, Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { addScratchRepos, apiData, expect, removeRepos, test, toasts } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [400] })

async function openDetails(page: Page, taskId: string) {
  await page.goto(`/#agents/${taskId}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  const details = page.getByRole('dialog').filter({ has: page.getByRole('definition') })
  await expect(details).toBeVisible()
  return details
}

/** The Directories rows, in the order the cog lists them. */
const directoryRows = (details: Locator) =>
  details
    .getByRole('definition')
    .filter({ has: details.page().getByRole('button', { name: 'Add repo or directory' }) })
    .getByRole('group')

const runsHere = (details: Locator, name: string) =>
  details.getByRole('group', { name }).getByRole('img', { name: 'Runs here' })

/** The task's latest audit event of a kind; audit writes can land just after the reply. */
async function audited(page: Page, kind: string, taskId: string) {
  const latest = async () =>
    (await apiData<AuditPage>(page.request, `/audit?kind=${kind}&limit=20`)).events.find(
      (event) => event.subject_id === taskId,
    )
  await expect.poll(latest, { timeout: 10_000 }).toBeDefined()
  return latest()
}

test('agent details add and remove a repo and a directory and move the working directory', async ({
  page,
  request,
}) => {
  const [api, web] = await addScratchRepos(request)
  const scratch = path.join(paths.home, 'work', `e2e-scratch-${randomUUID().slice(0, 8)}`)
  const notes = path.join(paths.home, `notes-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(scratch, { recursive: true })
  fs.mkdirSync(notes, { recursive: true })
  const id = randomUUID()
  const db = openSeedDb()
  await db.idleTask(id, 'E2E grows', scratch, new Date().toISOString())
  await db.close()

  const details = await openDetails(page, id)
  await expect(runsHere(details, scratch)).toBeVisible()

  await details.getByRole('button', { name: 'Add repo or directory' }).click()
  const adder = page.getByRole('dialog').filter({ has: page.getByLabel('Repo', { exact: true }) })
  await adder.getByLabel('Repo', { exact: true }).selectOption(api.id)
  await adder.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' }).first()).toBeVisible()
  const apiRow = details.getByRole('group', { name: api.slug })
  await expect(apiRow).toContainText(paths.checkout)
  await expect(apiRow).not.toContainText(api.slug)
  await expect(apiRow.getByRole('button', { name: `Copy path of ${api.slug.split('/').pop() ?? ''}` })).toBeVisible()
  await expect(directoryRows(details)).toHaveCount(2)
  await expect(directoryRows(details).first()).toHaveAttribute('aria-label', scratch)
  expect((await apiData<Task>(request, `/tasks/${id}`)).repos).toEqual([
    { id: api.id, slug: api.slug, dir: paths.checkout, worktree: false },
  ])
  expect((await audited(page, 'task.repo_added', id))?.summary).toBe(`Added ${api.slug} to task "E2E grows"`)

  await details.getByRole('button', { name: `Remove ${api.slug}` }).click()
  const confirmRemove = page.getByRole('dialog', { name: 'Confirm' })
  await expect(confirmRemove).toContainText(`Remove ${api.slug} from this agent? Its files stay.`)
  await confirmRemove.getByRole('button', { name: 'Remove' }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).repos).toEqual([])
  expect(fs.existsSync(paths.checkout)).toBe(true)
  expect(await audited(page, 'task.repo_removed', id)).toBeDefined()

  await expect(details).toBeVisible()
  await details.getByRole('button', { name: 'Add repo or directory' }).click()
  await page.getByRole('button', { name: 'Directory', exact: true }).click()
  await page.getByLabel('Directory path').fill('/nonexistent/e2e')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(toasts(page).filter({ hasText: '/nonexistent/e2e is not an existing directory' })).toBeVisible()
  await page.getByLabel('Directory path').fill(notes)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(details.getByRole('group', { name: notes })).toBeVisible()
  expect((await apiData<Task>(request, `/tasks/${id}`)).dirs).toEqual([notes])

  await details.getByRole('button', { name: `Work in ${notes}` }).click()
  const confirmMove = page.getByRole('dialog', { name: 'Change the working directory?' })
  await confirmMove.getByRole('button', { name: 'Work here' }).click()
  await expect
    .poll(async () => {
      const task = await apiData<Task>(request, `/tasks/${id}`)
      return { cwd: task.cwd, dirs: task.dirs }
    })
    .toEqual({ cwd: notes, dirs: [scratch] })
  expect((await audited(page, 'task.cwd_changed', id))?.detail).toMatchObject({ cwd: notes, previous_cwd: scratch })

  await expect(details).toBeVisible()
  await expect(runsHere(details, notes)).toBeVisible()
  await expect(runsHere(details, scratch)).toHaveCount(0)
  await expect(directoryRows(details).first()).toHaveAttribute('aria-label', notes)
  await details.getByRole('button', { name: `Remove ${scratch}` }).click()
  await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Remove' }).click()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).dirs).toEqual([])
  expect(fs.existsSync(scratch)).toBe(true)
  expect(await audited(page, 'task.dir_removed', id)).toBeDefined()
  await removeRepos(request, [api, web])
})
